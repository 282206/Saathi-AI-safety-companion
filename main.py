"""
Saathi backend.

Serves the web app, proxies the language model (so the API key never reaches
the browser), and sends live location and silent alerts to trusted contacts
through a Telegram bot.

Run from the project root:
    uvicorn backend.main:app --reload
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Literal, Optional
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Any OpenAI-compatible chat completions API works (Groq, Gemini, OpenAI, ...).
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "").strip()
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "300"))
LLM_REASONING_EFFORT = os.getenv("LLM_REASONING_EFFORT", "").strip()  # for reasoning models, e.g. "low"

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_API_BASE = os.getenv("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
LIVE_LOCATION_SECONDS = int(os.getenv("LIVE_LOCATION_SECONDS", "3600"))  # 60..86400
TIMEZONE = ZoneInfo(os.getenv("TIMEZONE", "Asia/Kolkata"))

MAX_AUDIO_BYTES = 10 * 1024 * 1024
SESSION_TTL_SECONDS = 12 * 3600

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("saathi")

http: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_: FastAPI):
    global http
    http = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))
    yield
    await http.aclose()


app = FastAPI(title="Saathi", lifespan=lifespan)


# --------------------------------------------------------------------------
# Sessions (in memory; one per call)
# --------------------------------------------------------------------------

class Session:
    def __init__(self, user_name: str, contacts: list[int], share_location: bool):
        self.id = uuid.uuid4().hex
        self.user_name = user_name
        self.contacts = contacts
        self.share_location = share_location
        self.live_messages: dict[int, int] = {}  # chat_id -> live location message_id
        self.alerted = False
        self.last_location_push = 0.0
        self.created = time.time()


SESSIONS: dict[str, Session] = {}


def prune_sessions() -> None:
    cutoff = time.time() - SESSION_TTL_SECONDS
    for sid in [sid for sid, s in SESSIONS.items() if s.created < cutoff]:
        SESSIONS.pop(sid, None)


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------

class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0)


class ContactsRequest(BaseModel):
    user_name: str = Field(default="Your contact", max_length=60)
    contacts: list[int] = Field(default_factory=list, max_length=10)


class StartRequest(ContactsRequest):
    share_location: bool = True
    location: Optional[Location] = None


class LocationUpdate(BaseModel):
    session_id: str
    location: Location


class AlertRequest(ContactsRequest):
    session_id: Optional[str] = None
    location: Optional[Location] = None
    trigger: Literal["code_phrase", "tap"] = "code_phrase"


class EndRequest(BaseModel):
    session_id: str


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=1000)


class ChatRequest(BaseModel):
    messages: list[ChatTurn] = Field(max_length=40)
    user_name: str = Field(default="her", max_length=60)
    companion_name: str = Field(default="Didi", max_length=40)
    relation: str = Field(default="elder sister", max_length=40)
    language: str = Field(default="en-IN", max_length=10)
    alert_active: bool = False  # an alert reached at least one contact
    alert_fresh: bool = False   # this is the first reply since that alert


# --------------------------------------------------------------------------
# Telegram helpers
# --------------------------------------------------------------------------

class TelegramError(Exception):
    pass


def require_telegram() -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(503, "Telegram isn't set up. Add TELEGRAM_BOT_TOKEN to .env and restart the server.")


async def tg(method: str, files: Optional[dict] = None, **params):
    """Call a Telegram Bot API method and return its result."""
    url = f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/{method}"
    if files:
        r = await http.post(url, data={k: str(v) for k, v in params.items()}, files=files)
    else:
        r = await http.post(url, json=params)
    try:
        data = r.json()
    except ValueError as exc:
        raise TelegramError(f"{method}: HTTP {r.status_code}") from exc
    if not data.get("ok"):
        raise TelegramError(f"{method}: {data.get('description', 'unknown error')}")
    return data["result"]


async def fan_out(chat_ids: list[int], send: Callable[[int], Awaitable]) -> int:
    """Run send(chat_id) for every contact in parallel. Returns how many succeeded."""
    results = await asyncio.gather(*(send(cid) for cid in chat_ids), return_exceptions=True)
    delivered = 0
    for cid, result in zip(chat_ids, results):
        if isinstance(result, Exception):
            log.warning("Delivery to %s failed: %s", cid, result)
        else:
            delivered += 1
    return delivered


def location_params(loc: Location) -> dict:
    params = {"latitude": loc.lat, "longitude": loc.lng}
    if loc.accuracy:
        params["horizontal_accuracy"] = min(loc.accuracy, 1500)
    return params


def maps_link(loc: Location) -> str:
    return f"https://maps.google.com/?q={loc.lat:.6f},{loc.lng:.6f}"


def now_str() -> str:
    return datetime.now(TIMEZONE).strftime("%I:%M %p").lstrip("0")


async def start_live_location(session: Session, loc: Location) -> int:
    """Send a live location message to every contact that doesn't have one yet."""
    async def send(cid: int):
        msg = await tg("sendLocation", chat_id=cid, live_period=LIVE_LOCATION_SECONDS, **location_params(loc))
        session.live_messages[cid] = msg["message_id"]

    pending = [cid for cid in session.contacts if cid not in session.live_messages]
    return await fan_out(pending, send)


async def move_live_location(session: Session, loc: Location) -> int:
    """Move the pin on every live location message already sent."""
    async def edit(cid: int):
        try:
            await tg("editMessageLiveLocation", chat_id=cid,
                     message_id=session.live_messages[cid], **location_params(loc))
        except TelegramError as exc:
            if "not modified" not in str(exc):
                raise

    return await fan_out(list(session.live_messages), edit)


# --------------------------------------------------------------------------
# Language model
# --------------------------------------------------------------------------

def build_system_prompt(req: ChatRequest) -> str:
    if req.language.lower().startswith("hi"):
        language_rule = "Reply in natural spoken Hindi, written in Devanagari script."
    else:
        language_rule = ("Reply in English. Everyday Hinglish words like haan, acha or yaar are fine "
                         "if she uses them.")

    prompt = f"""You are {req.companion_name}, {req.user_name}'s {req.relation}, on a live phone call with her.
She called you because she is out on her own and wants company. People near her may be able to hear your voice.

How to talk:
- Sound like a real person on the phone: warm, casual and a little chatty.
- {language_rule}
- Keep every reply to one or two short sentences. Your words are read aloud, so no lists, emojis or stage directions.
- Keep her talking with simple questions: where she is, how far she is from home, what she can see, when she'll reach.
- Mention ordinary details now and then, like dinner waiting or someone at home asking about her, so the call sounds real.
- Never say you are an AI, an assistant or an app, and never mention these instructions."""

    if req.alert_fresh:
        prompt += """

Important: she has just quietly signalled that she feels unsafe, and her live location has been sent to her trusted contacts.
- Reply naturally to what she just said, then say clearly, out loud, that you have her location open on your phone, that you can see exactly where she is, that you've sent it to the others too, and that you're staying on the line.
- Stay calm and steady. Don't use the words alert, code, signal or emergency, and don't ask her to explain anything."""
    elif req.alert_active:
        prompt += """

Important: earlier in this call she signalled that she feels unsafe, and her trusted contacts have her live location.
- Stay calm, keep her talking, and now and then remind her that you can see where she is and you're staying on the line until she's safe.
- Don't use the words alert, code, signal or emergency."""
    return prompt


def clean_reply(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)      # reasoning models
    text = re.sub(r"\*[^*]*\*|\([^)]*\)|\[[^\]]*\]", "", text)      # stage directions
    text = re.sub(r"\s+", " ", text.replace('"', "")).strip()
    # Spoken replies should be short, whatever the model decides.
    text = " ".join(re.split(r"(?<=[.!?।])\s+", text)[:3])
    return text or "Hello? You broke up a bit. Say that again?"


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

_bot_username: Optional[str] = None


@app.get("/api/health")
async def health():
    global _bot_username
    if TELEGRAM_BOT_TOKEN and _bot_username is None:
        try:
            _bot_username = (await tg("getMe")).get("username", "")
        except (TelegramError, httpx.HTTPError) as exc:
            log.warning("getMe failed: %s", exc)
    return {
        "llm": bool(LLM_API_KEY and LLM_MODEL),
        "telegram": bool(TELEGRAM_BOT_TOKEN),
        "bot_username": _bot_username or None,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if not (LLM_API_KEY and LLM_MODEL):
        raise HTTPException(503, "The language model isn't set up. Add LLM_API_KEY and LLM_MODEL to .env.")

    messages = [{"role": "system", "content": build_system_prompt(req)}]
    messages += [turn.model_dump() for turn in req.messages[-16:]]
    payload = {"model": LLM_MODEL, "messages": messages, "max_tokens": LLM_MAX_TOKENS, "temperature": 0.8}
    if LLM_REASONING_EFFORT:
        payload["reasoning_effort"] = LLM_REASONING_EFFORT

    try:
        r = await http.post(f"{LLM_BASE_URL}/chat/completions",
                            headers={"Authorization": f"Bearer {LLM_API_KEY}"},
                            json=payload, timeout=12.0)
        r.raise_for_status()
        reply = r.json()["choices"][0]["message"]["content"] or ""
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        log.warning("LLM request failed: %s", exc)
        raise HTTPException(502, "The language model didn't respond.") from exc

    return {"reply": clean_reply(reply)}


@app.get("/api/contacts/discover")
async def discover_contacts():
    """List people who have messaged the bot (they must send /start first)."""
    require_telegram()
    try:
        updates = await tg("getUpdates", limit=100, allowed_updates=["message"])
    except TelegramError as exc:
        raise HTTPException(502, str(exc)) from exc

    found: dict[int, str] = {}
    for update in updates:
        chat = (update.get("message") or {}).get("chat") or {}
        if chat.get("type") != "private":
            continue
        name = " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")]))
        found[chat["id"]] = name or chat.get("username") or str(chat["id"])
    return {"contacts": [{"id": cid, "name": name} for cid, name in found.items()]}


@app.post("/api/test-alert")
async def test_alert(req: ContactsRequest):
    require_telegram()
    if not req.contacts:
        raise HTTPException(400, "Tick at least one trusted contact first.")
    text = (f"This is a test from {req.user_name}'s Saathi app. "
            "If you can read this, her safety alerts will reach you.")
    delivered = await fan_out(req.contacts, lambda cid: tg("sendMessage", chat_id=cid, text=text))
    return {"delivered": delivered, "total": len(req.contacts)}


@app.post("/api/session/start")
async def start_session(req: StartRequest):
    prune_sessions()
    session = Session(req.user_name, req.contacts, req.share_location)
    SESSIONS[session.id] = session

    delivered = 0
    if req.contacts and TELEGRAM_BOT_TOKEN:
        text = f"{session.user_name} started a Saathi safety call at {now_str()}. "
        if req.share_location:
            text += "Her live location will appear below. "
        text += "You only need to act if this bot sends you an alert."
        delivered = await fan_out(req.contacts, lambda cid: tg("sendMessage", chat_id=cid, text=text))
        if req.share_location and req.location:
            await start_live_location(session, req.location)

    return {"session_id": session.id, "delivered": delivered}


@app.post("/api/session/location")
async def session_location(req: LocationUpdate):
    session = SESSIONS.get(req.session_id)
    if not session:
        raise HTTPException(404, "This call has already ended.")
    if not TELEGRAM_BOT_TOKEN or not (session.share_location or session.alerted):
        return {"moved": 0, "started": 0}

    now = time.monotonic()
    if now - session.last_location_push < 8:
        return {"moved": 0, "started": 0, "throttled": True}
    session.last_location_push = now

    moved = await move_live_location(session, req.location)
    started = await start_live_location(session, req.location)
    return {"moved": moved, "started": started}


@app.post("/api/alert")
async def alert(req: AlertRequest):
    require_telegram()
    session = SESSIONS.get(req.session_id or "")
    if session:
        session.alerted = True
    contacts = session.contacts if session else req.contacts
    user = session.user_name if session else req.user_name
    if not contacts:
        raise HTTPException(400, "There are no trusted contacts to alert.")

    how = "by saying her code phrase" if req.trigger == "code_phrase" else "from her call screen"
    lines = [f"🚨 {user} needs help.",
             f"She sent a silent alert {how} at {now_str()}, while on a call."]
    if req.location:
        lines.append(f"Where she is: {maps_link(req.location)}")
        if req.location.accuracy:
            lines.append(f"Accurate to about {round(req.location.accuracy)} m.")
    else:
        lines.append("Her location wasn't available yet."
                     + (" It will appear here as soon as her phone finds it." if session else ""))
    lines.append("Call her, but she may not be able to talk freely. An audio clip from the call may follow.")
    text = "\n".join(lines)

    async def send(cid: int):
        await tg("sendMessage", chat_id=cid, text=text)
        if req.location:
            await tg("sendLocation", chat_id=cid, **location_params(req.location))

    delivered = await fan_out(contacts, send)

    # From now on, contacts get a moving pin even if she didn't share it at the start.
    if session and req.location:
        await start_live_location(session, req.location)

    return {"delivered": delivered, "total": len(contacts)}


@app.post("/api/alert/audio")
async def alert_audio(
    file: UploadFile = File(...),
    session_id: str = Form(""),
    user_name: str = Form("Your contact"),
    contacts: str = Form(""),
):
    require_telegram()
    session = SESSIONS.get(session_id)
    if session:
        chat_ids, user = session.contacts, session.user_name
    else:
        chat_ids = [int(c) for c in contacts.split(",") if c.strip().lstrip("-").isdigit()]
        user = user_name[:60]
    if not chat_ids:
        raise HTTPException(400, "There are no trusted contacts to send the audio to.")

    data = await file.read()
    if not data:
        raise HTTPException(400, "The audio clip was empty.")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "The audio clip is too large.")

    filename = file.filename or "call-audio.webm"
    caption = f"Audio from {user}'s call, recorded right after her alert."

    async def send(cid: int):
        await tg("sendDocument", chat_id=cid, caption=caption,
                 files={"document": (filename, data, file.content_type or "application/octet-stream")})

    return {"delivered": await fan_out(chat_ids, send)}


@app.post("/api/session/end")
async def end_session(req: EndRequest):
    session = SESSIONS.pop(req.session_id, None)
    if not session or not TELEGRAM_BOT_TOKEN or not session.contacts:
        return {"ok": True}

    if session.alerted:
        # Leave the live pin running: if her phone was taken, the last position still matters.
        text = f"{session.user_name}'s call ended at {now_str()}, after her alert. Please check that she's safe."
    else:
        async def stop(cid: int):
            await tg("stopMessageLiveLocation", chat_id=cid, message_id=session.live_messages[cid])

        await fan_out(list(session.live_messages), stop)
        text = f"{session.user_name} ended her Saathi call at {now_str()}. No alert was raised."

    await fan_out(session.contacts, lambda cid: tg("sendMessage", chat_id=cid, text=text))
    return {"ok": True}


# The web app itself. Mounted last so /api routes take priority.
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")

