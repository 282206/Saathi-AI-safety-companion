"use strict";

/* ==========================================================================
   Saathi — client
   The call loop: listen (Web Speech API) -> reply (LLM via /api/chat) -> speak
   (speechSynthesis) -> listen again. Alongside it: live location to trusted
   contacts, and a silent alert when the code phrase is heard or the caller's
   photo is tapped three times.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canSpeak = "speechSynthesis" in window;

const STORAGE_KEY = "saathi.settings.v1";
const DEFAULTS = {
  userName: "",
  companionName: "Didi",
  relation: "elder sister",
  voiceURI: "",
  lang: "en-IN",
  codePhrase: "did you feed the cat",
  contacts: [],          // [{ id, name, enabled }]
  shareLocation: true,
  captions: false,
};

const OPENERS = [
  (n) => `Hey ${n}! Finally you called. Where are you right now?`,
  (n) => `Haan ${n}, bol! Are you on your way back?`,
  (n) => `${n}! I was just about to call you. Where have you reached?`,
];
const NUDGES = [
  "Hello? Are you there?",
  "Did I lose you? The network is so bad today.",
  "Are you still on the way? Tell me what you can see outside.",
];
const OFFLINE_REPLIES = [
  "Hmm, okay. Keep talking to me, I'm right here.",
  "Acha. How far are you now?",
  "Okay. Stay on the line with me till you reach, alright?",
  "Wait, you broke up a bit. Where are you now?",
];
const DETERRENT_LINES = [
  "Wait, I've got your location open on my phone now. I can see exactly where you are, and I've sent it to the others too. I'm staying on the line.",
  "Okay, listen. I can see where you are right now, and so can the others. I'm not hanging up, stay with me.",
];

const END_OF_TURN_MS = 900;     // pause after speech before we treat it as her turn
const SILENCE_NUDGE_MS = 20000; // caller checks in if she goes quiet
const LOCATION_PUSH_MS = 12000;
const ALERT_RETRY_MS = 10000;
const CLIP_MS = 20000;

let settings = loadSettings();
let health = { llm: true, telegram: true };
let call = newCall();
let currentUtterance = null; // keep a reference: Chrome can drop utterances that get garbage-collected

/* ---------- Settings ---------- */

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const TEXT_FIELDS = ["userName", "companionName", "relation", "voiceURI", "lang", "codePhrase"];
const CHECK_FIELDS = ["shareLocation", "captions"];

function fillForm() {
  for (const key of TEXT_FIELDS) $(`#${key}`).value = settings[key];
  for (const key of CHECK_FIELDS) $(`#${key}`).checked = !!settings[key];
  renderContacts();
}

function onFormChange(e) {
  const el = e.target;
  if (TEXT_FIELDS.includes(el.id)) settings[el.id] = el.value;
  else if (CHECK_FIELDS.includes(el.id)) settings[el.id] = el.checked;
  else return;
  saveSettings();
}

const firstName = () => settings.userName.trim().split(/\s+/)[0] || "yaar";
const companionName = () => settings.companionName.trim() || "Didi";
const activeContactIds = () => settings.contacts.filter((c) => c.enabled !== false).map((c) => c.id);

/* ---------- Contacts ---------- */

function renderContacts() {
  renderLocationContactOptions();
  const list = $("#contactList");
  list.replaceChildren();
  if (!settings.contacts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No contacts yet.";
    list.append(li);
    return;
  }
  for (const c of settings.contacts) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = c.enabled !== false;
    box.dataset.contact = String(c.id);
    const name = document.createElement("span");
    name.textContent = c.name;
    label.append(box, name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.dataset.remove = String(c.id);
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${c.name}`);
    li.append(label, remove);
    list.append(li);
  }
}

function renderLocationContactOptions() {
  const select = $("#locationContact");
  const previous = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = settings.contacts.length ? "Choose a trusted contact" : "Find contacts first";
  select.append(placeholder);

  for (const c of settings.contacts) {
    const option = document.createElement("option");
    option.value = String(c.id);
    option.textContent = c.name;
    select.append(option);
  }

  if (settings.contacts.some((c) => String(c.id) === previous)) select.value = previous;
}

function contactStatus(text) { $("#contactStatus").textContent = text; }

function locationStatus(text) { $("#locationStatus").textContent = text; }

async function sendCurrentLocation() {
  const contactId = $("#locationContact").value;
  if (!contactId) {
    locationStatus("Choose a trusted contact first.");
    return;
  }

  const btn = $("#sendLocation");
  btn.disabled = true;
  locationStatus("Getting your current location…");

  try {
    const location = await currentPosition(15000);
    if (!location) {
      locationStatus("Couldn't get your location. Check that location permission is allowed and GPS is available.");
      return;
    }

    locationStatus("Sending your location through Telegram…");
    const result = await api("/api/location/send", {
      user_name: settings.userName.trim() || "Your contact",
      contact_id: Number(contactId),
      location,
    });

    locationStatus(result.delivered
      ? "Your current location was sent successfully."
      : "Telegram couldn't deliver your location. Ask the contact to send /start to the bot.");
  } catch (e) {
    locationStatus(e.message || "Couldn't send your location.");
  } finally {
    btn.disabled = false;
  }
}

async function findContacts() {
  const btn = $("#findContacts");
  btn.disabled = true;
  contactStatus("Looking for people who messaged your bot…");
  try {
    const { contacts } = await api("/api/contacts/discover");
    let added = 0;
    for (const c of contacts) {
      if (!settings.contacts.some((x) => x.id === c.id)) {
        settings.contacts.push({ ...c, enabled: true });
        added++;
      }
    }
    saveSettings();
    renderContacts();
    if (!contacts.length) contactStatus("Nobody has messaged the bot yet. Ask them to send /start, then try again.");
    else if (added) contactStatus(`Added ${added} contact${added > 1 ? "s" : ""}. Send a test message to check it reaches them.`);
    else contactStatus("No new contacts. Everyone who messaged the bot is already listed.");
  } catch (e) {
    contactStatus(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function sendTestAlert() {
  const ids = activeContactIds();
  if (!ids.length) return contactStatus("Tick at least one contact first.");
  const btn = $("#testAlert");
  btn.disabled = true;
  contactStatus("Sending…");
  try {
    const r = await api("/api/test-alert", { user_name: settings.userName.trim() || "Your contact", contacts: ids });
    contactStatus(r.delivered === r.total
      ? `Test message sent to ${r.total === 1 ? "your contact" : `all ${r.total} contacts`}.`
      : `Sent to ${r.delivered} of ${r.total}. Anyone who didn't get it should send /start to the bot again.`);
  } catch (e) {
    contactStatus(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Server ---------- */

async function api(path, body, { timeout = 10000, keepalive = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      keepalive,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : `The server returned an error (${res.status}).`;
      throw new Error(detail);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The server took too long to answer.");
    if (e instanceof TypeError) throw new Error("Can't reach the Saathi server. Check your connection.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth() {
  const notes = [];
  if (!window.isSecureContext) notes.push("The microphone and location only work over HTTPS or on localhost.");
  if (!SpeechRecognition || !canSpeak) notes.push("This browser can't hold a voice call. Open Saathi in Chrome or Edge.");
  try {
    health = await api("/api/health");
    if (!health.llm) notes.push("The caller's AI isn't connected, so calls will use a few pre-written lines. Add LLM_API_KEY and LLM_MODEL to .env and restart the server.");
    if (!health.telegram) notes.push("Alerts can't be sent yet. Add TELEGRAM_BOT_TOKEN to .env and restart the server.");
    if (health.bot_username) {
      const link = $("#botLink");
      link.href = `https://t.me/${health.bot_username}`;
      link.textContent = `@${health.bot_username}`;
    }
  } catch {
    notes.push("Can't reach the Saathi server. Check that it's running, then reload this page.");
  }
  const box = $("#notices");
  box.replaceChildren(...notes.map((text) => {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = text;
    return p;
  }));
}

/* ---------- Voices ---------- */

function voiceRank(v) {
  if (/^(en-IN|hi-IN)/i.test(v.lang)) return 0;
  if (/^en/i.test(v.lang)) return 1;
  return 2;
}

function populateVoices() {
  if (!canSpeak) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const select = $("#voiceURI");
  const options = [new Option("Automatic", "")];
  [...voices]
    .filter((v) => voiceRank(v) < 2)
    .sort((a, b) => voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name))
    .forEach((v) => options.push(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
  select.replaceChildren(...options);
  select.value = settings.voiceURI;
  if (select.value !== settings.voiceURI) select.value = "";
}

function pickVoice() {
  if (!canSpeak) return null;
  const voices = speechSynthesis.getVoices();
  const lang = settings.lang.toLowerCase();
  return voices.find((v) => v.voiceURI === settings.voiceURI)
    || voices.find((v) => v.lang.toLowerCase() === lang)
    || voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)))
    || null;
}

function previewVoice() {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance(`Hi ${firstName()}, it's ${companionName()}. Where are you right now?`);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = settings.lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ---------- Call state ---------- */

function newCall() {
  return {
    active: false,
    sessionId: null,
    history: [],          // [{ role: "user" | "assistant", content }]
    speaking: false,
    thinking: false,
    muted: false,
    speaker: true,
    recognizer: null,
    restartDelay: 250,
    micBlocked: false,
    endOfTurnTimer: null,
    silenceTimer: null,
    nudges: 0,
    timerId: null,
    startedAt: 0,
    watchId: null,
    locationTimer: null,
    lastPos: null,
    wakeLock: null,
    alertInFlight: false,
    alertDelivered: false,
    alertFreshForReply: false,
    lastAlertAttempt: 0,
    alertPromise: null,
    clipStarted: false,
    recorder: null,
    taps: [],
  };
}

/* ---------- Starting and ending ---------- */

async function startCall() {
  if (call.active) return;

  // Unlock speech output while we still have the user's tap (needed on mobile browsers).
  if (canSpeak) {
    speechSynthesis.cancel();
    const warm = new SpeechSynthesisUtterance(" ");
    warm.volume = 0;
    speechSynthesis.speak(warm);
  }

  if (!SpeechRecognition || !canSpeak) return toast("This browser can't hold a voice call. Open Saathi in Chrome or Edge.");
  if (!settings.userName.trim()) {
    toast("Add your name first.");
    return $("#userName").focus();
  }
  if (!activeContactIds().length &&
      !confirm("No trusted contacts are ticked, so an alert won't reach anyone. Start the call anyway?")) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    return toast("Saathi needs the microphone to hear you. Allow it in your browser's site settings.");
  }

  const c = (call = newCall());
  c.active = true;
  showCallScreen();
  startLocation(c);
  requestWakeLock(c);

  api("/api/session/start", {
    user_name: settings.userName.trim(),
    contacts: activeContactIds(),
    share_location: settings.shareLocation,
    location: c.lastPos,
  }).then((r) => {
    if (c.active) {
      c.sessionId = r.session_id;
      pushLocation(c, true);
    } else {
      api("/api/session/end", { session_id: r.session_id }).catch(() => {});
    }
  }).catch(() => { /* alerts still work without a session */ });

  // A moment of "Calling…" before they pick up, like a real call.
  await sleep(1600);
  if (!c.active) return;
  c.startedAt = Date.now();
  startTimer(c);

  await say(c, pick(OPENERS)(firstName()));
  startListening(c);
}

function endCall() {
  const c = call;
  if (!c.active) return;
  c.active = false;
  stopListening(c);
  if (canSpeak) speechSynthesis.cancel();
  clearTimeout(c.endOfTurnTimer);
  clearTimeout(c.silenceTimer);
  clearInterval(c.timerId);
  clearInterval(c.locationTimer);
  if (c.watchId !== null) navigator.geolocation.clearWatch(c.watchId);
  c.wakeLock?.release?.().catch(() => {});
  if (c.recorder?.state === "recording") c.recorder.stop(); // the clip still gets sent
  if (c.sessionId) api("/api/session/end", { session_id: c.sessionId }, { keepalive: true }).catch(() => {});

  $("#call").hidden = true;
  $("#setup").hidden = false;
  toast(c.alertDelivered ? "Call ended. Your contacts still have your last location." : "Call ended.");
}

function showCallScreen() {
  const name = companionName();
  $("#callName").textContent = name;
  $("#avatarInitial").textContent = name.charAt(0).toUpperCase();
  $("#callTimer").textContent = "Calling…";
  $("#captionBox").replaceChildren();
  $("#captionBox").hidden = !settings.captions;
  $("#callStatus").hidden = true;
  $("#muteBtn").setAttribute("aria-pressed", "false");
  $("#speakerBtn").setAttribute("aria-pressed", "true");
  $("#setup").hidden = true;
  $("#call").hidden = false;
}

function startTimer(c) {
  const el = $("#callTimer");
  const tick = () => {
    const s = Math.floor((Date.now() - c.startedAt) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  c.timerId = setInterval(tick, 1000);
}

async function requestWakeLock(c) {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      c.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch { /* not critical */ }
}

/* ---------- Speaking ---------- */

function speak(c, text) {
  return new Promise((resolve) => {
    stopListening(c);
    if (!c.active || !canSpeak) return resolve();

    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = settings.lang;
    u.rate = 1.03;
    u.volume = c.speaker ? 1 : 0.35;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      c.speaking = false;
      setTalking(false);
      resolve();
    };
    // Safety net in case the browser never fires onend.
    const guard = setTimeout(finish, 4000 + text.split(/\s+/).length * 600);
    u.onend = finish;
    u.onerror = finish;

    c.speaking = true;
    setTalking(true);
    currentUtterance = u;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

/** Add a caller line to the conversation, show it in captions and say it. */
async function say(c, text) {
  c.history.push({ role: "assistant", content: text });
  caption("them", text);
  await speak(c, text);
  resetSilenceTimer(c);
}

function setTalking(on) { $("#avatar").classList.toggle("talking", on); }

/* ---------- Listening ---------- */

function startListening(c) {
  if (!c.active || c.muted || c.speaking || c.thinking || c.recognizer || c.micBlocked) return;
  if (document.visibilityState !== "visible") return;

  const r = new SpeechRecognition();
  r.lang = settings.lang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  let finalText = "";
  const startedAt = Date.now();

  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += `${res[0].transcript} `;
      else interim += res[0].transcript;
    }
    // Check interim text too, so the alert goes out the moment the phrase is heard.
    if (matchesCodePhrase(`${finalText} ${interim}`)) triggerAlert(c, "code_phrase");

    c.nudges = 0;
    resetSilenceTimer(c);
    clearTimeout(c.endOfTurnTimer);
    if (finalText.trim()) {
      c.endOfTurnTimer = setTimeout(() => {
        const text = finalText.trim();
        finalText = "";
        if (text) handleUserTurn(c, text);
      }, END_OF_TURN_MS);
    }
  };

  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      c.micBlocked = true;
      callStatus("The browser blocked the microphone.");
    }
  };

  r.onend = () => {
    if (c.recognizer !== r) return; // we stopped it on purpose
    c.recognizer = null;
    // Back off if the recognizer keeps ending straight away (offline, errors).
    c.restartDelay = Date.now() - startedAt < 1000 ? Math.min(c.restartDelay * 2, 4000) : 250;
    setTimeout(() => startListening(c), c.restartDelay);
  };

  c.recognizer = r;
  try { r.start(); } catch { c.recognizer = null; }
  resetSilenceTimer(c);
}

function stopListening(c) {
  const r = c.recognizer;
  c.recognizer = null;
  clearTimeout(c.endOfTurnTimer);
  if (r) {
    r.onresult = null;
    try { r.abort(); } catch { /* already stopped */ }
  }
}

async function handleUserTurn(c, text) {
  if (!c.active) return;
  stopListening(c);
  c.thinking = true;
  c.history.push({ role: "user", content: text });
  caption("you", text);

  // If this sentence fired the alert, wait briefly so the reply can reflect it.
  if (c.alertPromise) await Promise.race([c.alertPromise, sleep(3000)]);

  const fresh = c.alertDelivered && c.alertFreshForReply;
  let reply;
  try {
    reply = health.llm ? await fetchReply(c, fresh) : null;
  } catch {
    reply = null;
  }
  if (!reply) reply = fresh ? pick(DETERRENT_LINES) : pick(OFFLINE_REPLIES);
  if (fresh) c.alertFreshForReply = false;

  c.thinking = false;
  if (!c.active) return;
  await say(c, reply);
  startListening(c);
}

async function fetchReply(c, fresh) {
  const { reply } = await api("/api/chat", {
    messages: c.history.slice(-16),
    user_name: firstName(),
    companion_name: companionName(),
    relation: settings.relation,
    language: settings.lang,
    alert_active: c.alertDelivered,
    alert_fresh: fresh,
  }, { timeout: 9000 });
  return reply;
}

function resetSilenceTimer(c) {
  clearTimeout(c.silenceTimer);
  if (!c.active) return;
  c.silenceTimer = setTimeout(async () => {
    if (!c.active || c.muted) return;
    if (c.speaking || c.thinking) return resetSilenceTimer(c);
    if (c.nudges >= NUDGES.length) return; // don't nag forever
    const line = NUDGES[c.nudges++];
    await say(c, line);
    startListening(c);
  }, SILENCE_NUDGE_MS);
}

/* ---------- Code phrase ---------- */

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if the phrase was said, allowing for one misheard word in longer phrases. */
function matchesCodePhrase(text) {
  const phrase = normalize(settings.codePhrase);
  if (!phrase) return false;
  const heard = normalize(text);
  if (heard.includes(phrase)) return true;
  const words = phrase.split(" ");
  if (words.length < 4) return false;
  const heardWords = new Set(heard.split(" "));
  const hits = words.filter((w) => heardWords.has(w)).length;
  return hits / words.length >= 0.75;
}

/* ---------- Alerts ---------- */

function triggerAlert(c, trigger) {
  if (!c.active || c.alertDelivered || c.alertInFlight) return null;
  if (Date.now() - c.lastAlertAttempt < ALERT_RETRY_MS) return null;
  c.alertInFlight = true;
  c.lastAlertAttempt = Date.now();

  c.alertPromise = (async () => {
    const location = c.lastPos || (await currentPosition(4000));
    let delivered = 0;
    try {
      const r = await api("/api/alert", {
        session_id: c.sessionId,
        user_name: settings.userName.trim(),
        contacts: activeContactIds(),
        location,
        trigger,
      }, { timeout: 12000 });
      delivered = r.delivered || 0;
    } catch { /* reported below */ }

    c.alertInFlight = false;
    c.alertDelivered = delivered > 0;
    c.alertFreshForReply = c.alertDelivered;
    // A buzz only she can feel: two short pulses = sent, one long = failed (say it again to retry).
    navigator.vibrate?.(c.alertDelivered ? [70, 90, 70] : [700]);
    callStatus(c.alertDelivered
      ? `Alert sent to ${delivered} contact${delivered > 1 ? "s" : ""}.`
      : "The alert couldn't be sent. Say the phrase again to retry.");
    return c.alertDelivered;
  })();

  if (!c.clipStarted) {
    c.clipStarted = true;
    recordClip(c, CLIP_MS);
  }
  return c.alertPromise;
}

async function onAvatarTap() {
  const c = call;
  if (!c.active) return;
  const now = Date.now();
  c.taps = c.taps.filter((t) => now - t < 900);
  c.taps.push(now);
  if (c.taps.length < 3) return;
  c.taps = [];

  const sent = await triggerAlert(c, "tap");
  // If the caller is just listening, speak up so anyone nearby hears it.
  if (sent && c.active && !c.speaking && !c.thinking) {
    c.alertFreshForReply = false;
    await say(c, pick(DETERRENT_LINES));
    startListening(c);
  }
}

async function recordClip(c, ms) {
  if (!window.MediaRecorder || !navigator.mediaDevices) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return;
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) return;
    const mime = rec.mimeType || type || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    const form = new FormData();
    form.append("file", blob, `call-audio.${mime.includes("mp4") ? "m4a" : "webm"}`);
    form.append("session_id", c.sessionId || "");
    form.append("user_name", settings.userName.trim());
    form.append("contacts", activeContactIds().join(","));
    try { await fetch("/api/alert/audio", { method: "POST", body: form }); } catch { /* best effort */ }
  };
  c.recorder = rec;
  rec.start(1000);
  setTimeout(() => { if (rec.state === "recording") rec.stop(); }, ms);
}

/* ---------- Location ---------- */

function startLocation(c) {
  if (!("geolocation" in navigator)) return;
  c.watchId = navigator.geolocation.watchPosition(
    (p) => {
      const first = !c.lastPos;
      c.lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
      if (first) pushLocation(c, true);
    },
    () => { /* keep going without location */ },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  c.locationTimer = setInterval(() => pushLocation(c), LOCATION_PUSH_MS);
}

function pushLocation(c, force = false) {
  if (!c.active || !c.sessionId || !c.lastPos) return;
  if (!force && !settings.shareLocation && !c.alertDelivered) return;
  api("/api/session/location", { session_id: c.sessionId, location: c.lastPos }).catch(() => {});
}

function currentPosition(timeout) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

/* ---------- Captions and toasts ---------- */

/** Demo-only status line under the timer (alert sent, mic blocked). Hidden in real use. */
function callStatus(text) {
  const el = $("#callStatus");
  el.textContent = text;
  el.hidden = !settings.captions;
}

function caption(kind, text) {
  if (!settings.captions) return;
  const box = $("#captionBox");
  const p = document.createElement("p");
  p.className = kind;
  p.textContent = kind === "you" ? `You: ${text}` : `${companionName()}: ${text}`;
  box.append(p);
  while (box.children.length > 8) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

let toastTimer = null;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---------- Wiring ---------- */

function init() {
  fillForm();
  populateVoices();
  if (canSpeak) speechSynthesis.addEventListener("voiceschanged", populateVoices);
  checkHealth();

  const form = $("#settings");
  form.addEventListener("input", onFormChange);
  form.addEventListener("change", onFormChange);
  form.addEventListener("submit", (e) => e.preventDefault());

  $("#contactList").addEventListener("change", (e) => {
    const id = e.target.dataset.contact;
    if (!id) return;
    const contact = settings.contacts.find((c) => String(c.id) === id);
    if (contact) contact.enabled = e.target.checked;
    saveSettings();
  });
  $("#contactList").addEventListener("click", (e) => {
    const id = e.target.dataset.remove;
    if (!id) return;
    settings.contacts = settings.contacts.filter((c) => String(c.id) !== id);
    saveSettings();
    renderContacts();
  });

  $("#findContacts").addEventListener("click", findContacts);
  $("#testAlert").addEventListener("click", sendTestAlert);
  $("#sendLocation").addEventListener("click", sendCurrentLocation);
  $("#previewVoice").addEventListener("click", previewVoice);
  $("#startCall").addEventListener("click", startCall);
  $("#endBtn").addEventListener("click", endCall);
  $("#avatar").addEventListener("pointerdown", onAvatarTap);

  $("#muteBtn").addEventListener("click", (e) => {
    const c = call;
    c.muted = !c.muted;
    e.currentTarget.setAttribute("aria-pressed", String(c.muted));
    if (c.muted) stopListening(c);
    else startListening(c);
  });
  $("#speakerBtn").addEventListener("click", (e) => {
    call.speaker = !call.speaker;
    e.currentTarget.setAttribute("aria-pressed", String(call.speaker));
  });

  // Mobile browsers pause the microphone when the screen turns off; pick up again when she's back.
  document.addEventListener("visibilitychange", () => {
    if (call.active && document.visibilityState === "visible") {
      requestWakeLock(call);
      startListening(call);
    }
  });
}

init();
