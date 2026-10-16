/*
 * pad.js — the phone.
 *
 * Reads how the phone is tilted and sends it to the stage thirty times a
 * second on the lossy lane; a Pulse tap goes on the reliable one. Nothing
 * about the fight is decided here: the stage owns lives, hits and the
 * cooldown, and this file shows what it is told.
 *
 * THE SENSOR IS GATED TWICE, and both gates are why there is a Connect
 * button rather than connecting on load:
 *
 *   - iOS Safari hands out deviceorientation only after
 *     DeviceOrientationEvent.requestPermission() is called from a tap, and
 *     that call has to be the first thing the tap does — await anything
 *     before it and the gesture is spent.
 *   - Every browser withholds sensors (and the mic) outside a secure
 *     context. Pages is HTTPS; the Mac's LAN IP over http is not.
 *
 * So the pad never depends on the sensor: no reading within a second of
 * connecting turns the tray into a drag pad.
 *
 * Hold the phone like a tray. "Level" takes the current angle as flat.
 */

import { SYMBOLS, CODE_LENGTH, codeIcons } from "./net/codes.js";
import { joinRendezvous } from "./net/rendezvous.js";
import * as recorder from "./recorder.js";

const SEND_HZ = 30;
const FULL_TILT_DEG = 28; // this far from level is full speed

const $ = (id) => document.getElementById(id);

let started = "";
let channel = null;
let sendTimer = 0;
let tilt = { x: 0, y: 0 };
let zero = null; // { beta, gamma } taken as level
let raw = null;
let source = "none"; // "tilt" | "drag"
let dragging = false;
let myName = "";
let clip = null; // the last good take, Int16 PCM

/* ---------- the keypad, for a phone that did not scan ---------- */

export function startKeypad(onCode) {
  const picked = [];
  const slots = $("slots");
  const join = $("key-join");
  const paint = () => {
    slots.replaceChildren(
      ...Array.from({ length: CODE_LENGTH }, (_, i) => {
        const slot = document.createElement("span");
        slot.className = "slot";
        slot.textContent = picked[i]?.icon ?? "";
        return slot;
      }),
    );
    join.disabled = picked.length !== CODE_LENGTH;
  };
  $("keys").replaceChildren(
    ...SYMBOLS.map((s) => {
      const key = document.createElement("button");
      key.className = "key";
      key.textContent = s.icon;
      key.setAttribute("aria-label", s.name);
      key.addEventListener("click", () => {
        if (picked.length < CODE_LENGTH) picked.push(s);
        paint();
      });
      return key;
    }),
  );
  $("key-clear").onclick = () => {
    picked.length = 0;
    paint();
  };
  join.onclick = () => onCode(picked.map((s) => s.name).join("-"));
  paint();
}

/* ---------- connecting ---------- */

export function startPad(code) {
  if (started === code) return;
  started = code;
  $("pad-code").textContent = codeIcons(code).join(" ");
  $("pad-go").onclick = () => connect(code);
}

const faces = ["pad-connect", "pad-live", "pad-record"];
const face = (id) => {
  for (const f of faces) $(f).hidden = f !== id;
};

async function connect(code) {
  const button = $("pad-go");
  const error = $("pad-error");
  // First, before any await: this call spends the tap's user activation.
  const asked = askForSensor();
  button.disabled = true;
  button.textContent = "Connecting…";
  error.textContent = "";
  try {
    await asked;
    const room = await joinRendezvous(code);
    channel = room.channel;
  } catch (e) {
    button.disabled = false;
    button.textContent = "Try again";
    error.textContent = e?.message ?? String(e);
    return;
  }
  channel.onMessage = receive;
  channel.onClose = () => {
    clearInterval(sendTimer);
    recorder.close();
    face("pad-connect");
    button.disabled = false;
    button.textContent = "Reconnect";
    error.textContent = "Lost the screen.";
  };
  face("pad-live");
  wireLive();
  keepAwake();
  sendTimer = setInterval(send, 1000 / SEND_HZ);
  // Reconnected with a sound already made: the new stage-side blob has none.
  if (clip) sendClip(clip);
}

function askForSensor() {
  const D = window.DeviceOrientationEvent;
  if (typeof D?.requestPermission === "function") return D.requestPermission().catch(() => "denied");
  return Promise.resolve("granted");
}

/* ---------- reading the phone ---------- */

let wired = false;
function wireLive() {
  if (wired) return;
  wired = true;
  addEventListener("deviceorientation", onOrientation);
  setTimeout(() => {
    if (source === "none") setSource("drag");
  }, 1000);

  const tray = $("tray");
  const fromPointer = (e) => {
    const r = tray.getBoundingClientRect();
    tilt.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1);
    tilt.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1);
    paintDot();
  };
  tray.addEventListener("pointerdown", (e) => {
    if (source !== "drag") return;
    dragging = true;
    tray.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  tray.addEventListener("pointermove", (e) => {
    if (dragging) fromPointer(e);
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    // A thumb needs the stick to spring back.
    tilt = { x: 0, y: 0 };
    paintDot();
  };
  tray.addEventListener("pointerup", release);
  tray.addEventListener("pointercancel", release);

  $("pad-zero").onclick = () => {
    if (raw) zero = { ...raw };
  };
  // pointerdown, not click: in a fight the 100-odd ms a click waits for
  // the finger to lift is the difference between a hit and a miss.
  $("pad-tap").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    channel?.send({ t: "tap" });
  });
  $("pad-sound").onclick = openRecorder;
  wireRecorder();
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  if (source !== "tilt") setSource("tilt");
  raw = { beta: e.beta, gamma: e.gamma };
  if (!zero) zero = { ...raw };
  // Relative to "level", then turned to match the screen's rotation.
  const db = raw.beta - zero.beta;
  const dg = raw.gamma - zero.gamma;
  let x = dg;
  let y = db;
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  if (angle === 90) [x, y] = [db, -dg];
  else if (angle === -90 || angle === 270) [x, y] = [-db, dg];
  else if (angle === 180) [x, y] = [-dg, -db];
  tilt.x = clamp(x / FULL_TILT_DEG);
  tilt.y = clamp(y / FULL_TILT_DEG);
  paintDot();
}

function setSource(next) {
  source = next;
  $("pad-mode").textContent =
    next === "tilt"
      ? "Tilt the phone like a tray."
      : isSecureContext
        ? "No tilt sensor here — drag in the box."
        : "Tilt needs HTTPS — drag in the box instead.";
  $("pad-zero").hidden = next !== "tilt";
  $("tray").classList.toggle("drag", next === "drag");
}

const clamp = (v) => Math.max(-1, Math.min(1, v));

function paintDot() {
  $("tray-dot").style.translate = `${tilt.x * 34}vmin ${tilt.y * 34}vmin`;
}

/* ---------- recording the attack sound ---------- */

async function openRecorder() {
  face("pad-record");
  const status = $("rec-status");
  status.textContent = "Opening the microphone…";
  try {
    await recorder.open();
    status.textContent = clip ? "Saved. Hold to record a new one." : "Ready.";
  } catch (e) {
    status.textContent =
      e?.name === "NotAllowedError" ? "The microphone was refused — allow it in the browser to record." : (e?.message ?? String(e));
  }
}

function wireRecorder() {
  const hold = $("rec-hold");
  const status = $("rec-status");
  let holding = false;
  hold.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!recorder.isOpen()) return;
    holding = true;
    hold.setPointerCapture(e.pointerId);
    hold.classList.add("on");
    hold.textContent = "Recording…";
    recorder.start();
  });
  const release = () => {
    if (!holding) return;
    holding = false;
    hold.classList.remove("on");
    hold.textContent = "Hold to record";
    try {
      clip = recorder.stop();
    } catch (e) {
      status.textContent = e.message;
      return;
    }
    recorder.preview(clip);
    $("rec-play").disabled = false;
    status.textContent = "Sending to the screen…";
    sendClip(clip);
  };
  hold.addEventListener("pointerup", release);
  hold.addEventListener("pointercancel", release);
  $("rec-play").onclick = () => recorder.preview(clip);
  $("rec-done").onclick = () => {
    // Done closes the mic, so the phone stops listening to the room.
    recorder.close();
    face("pad-live");
  };
}

function sendClip(pcm) {
  const parts = recorder.toChunks(pcm);
  parts.forEach((d, i) => channel?.send({ t: "clip", i, n: parts.length, d }));
}

/* ---------- the wire ---------- */

function send() {
  channel?.send({ t: "tilt", x: +tilt.x.toFixed(3), y: +tilt.y.toFixed(3) }, true);
}

function receive(m) {
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "hello":
      if (/^#[0-9a-f]{6}$/i.test(m.colour)) document.documentElement.style.setProperty("--me", m.colour);
      myName = typeof m.name === "string" ? m.name.slice(0, 20) : "";
      $("pad-name").textContent = myName ? `You are ${myName}` : "";
      break;
    case "phase":
      paintPhase(m.phase, !!m.won);
      break;
    case "you":
      paintLives(Number(m.lives) || 0, !!m.alive);
      break;
    case "pulsed": {
      // The stage fired it; show the cooldown it will enforce.
      const button = $("pad-tap");
      const s = Math.max(0.1, Math.min(3, Number(m.cooldown) || 0.8));
      button.style.setProperty("--cd", `${s}s`);
      button.classList.remove("cooling");
      void button.offsetWidth;
      button.classList.add("cooling");
      break;
    }
    case "hit":
      navigator.vibrate?.([60, 40, 60]);
      flash("hurt");
      break;
    case "bump":
      navigator.vibrate?.(Math.round(15 + Math.max(0, Math.min(1, Number(m.s) || 0)) * 45));
      flash("hit");
      break;
    case "path":
      $("pad-path").textContent = m.path === "relay" ? "Connected via TURN relay" : "Connected directly";
      break;
    case "clip-ok":
      $("rec-status").textContent = "Saved on the screen. Pulse to hear it!";
      break;
    case "full":
      $("pad-error").textContent = "The screen is full.";
      break;
  }
}

let lastPhase = "lobby";
let lastAlive = true;
let lastWon = false;
function paintPhase(phase, won) {
  lastPhase = phase;
  lastWon = won;
  paintStatus();
}
function paintLives(lives, alive) {
  lastAlive = alive;
  $("pad-lives").textContent = lastPhase === "lobby" ? "" : alive ? "♥".repeat(lives) || "" : "";
  paintStatus();
}
function paintStatus() {
  $("pad-phase").textContent =
    lastPhase === "lobby"
      ? "Practice: pulses push, nobody gets hurt. Waiting for the start…"
      : lastPhase === "over"
        ? lastWon
          ? "You won! 🎉"
          : "Round over."
        : lastAlive
          ? "Fight! Pulse right next to someone."
          : "You're out — watch the screen. Next round soon.";
}

function flash(kind) {
  const tray = $("tray");
  tray.classList.remove("hit", "hurt");
  void tray.offsetWidth;
  tray.classList.add(kind);
}

/* A phone that locks mid-round stops sending; ask it not to. Every
 * reconnect calls this, and the listener only needs adding once. */
let awake = false;
function keepAwake() {
  if (awake) return;
  awake = true;
  const ask = async () => {
    try {
      if (document.visibilityState === "visible") await navigator.wakeLock?.request("screen");
    } catch {
      /* Refused or unsupported. */
    }
  };
  document.addEventListener("visibilitychange", ask);
  ask();
}
