/*
 * pad.js — the phone.
 *
 * Reads how the phone is tilted and sends it to the stage thirty times a
 * second on the lossy lane. Nothing else about the ball lives here: the
 * stage owns the physics, so this file only ever says "tilted this much".
 *
 * THE SENSOR IS GATED TWICE, and both gates are why there is a Connect
 * button rather than connecting on load:
 *
 *   - iOS Safari hands out deviceorientation only after
 *     DeviceOrientationEvent.requestPermission() is called from a tap, and
 *     that call has to be the first thing the tap does — await anything
 *     before it and the gesture is spent.
 *   - Every browser withholds the sensors outside a secure context. The
 *     Pages URL is HTTPS; a phone on the Mac's LAN IP over http is not.
 *
 * So the pad never depends on the sensor: if no reading arrives within a
 * second of connecting, the tray becomes a drag pad, and the demo still
 * shows the whole round trip.
 *
 * Hold the phone like a tray. "Level" takes the current angle as flat, so
 * it works sitting on a sofa as well as standing at a table.
 */

import { SYMBOLS, CODE_LENGTH, codeIcons } from "./net/codes.js";
import { joinRendezvous } from "./net/rendezvous.js";

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
    $("pad-live").hidden = true;
    $("pad-connect").hidden = false;
    button.disabled = false;
    button.textContent = "Reconnect";
    error.textContent = "Lost the screen.";
  };
  $("pad-connect").hidden = true;
  $("pad-live").hidden = false;
  wireLive();
  keepAwake();
  sendTimer = setInterval(send, 1000 / SEND_HZ);
}

function askForSensor() {
  const D = window.DeviceOrientationEvent;
  if (typeof D?.requestPermission === "function")
    return D.requestPermission().catch(() => "denied");
  return Promise.resolve("granted");
}

/* ---------- reading the phone ---------- */

let wired = false;
function wireLive() {
  if (wired) return;
  wired = true;
  addEventListener("deviceorientation", onOrientation);
  // No reading after a second means no sensor we may use: drag instead.
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
    // A joystick springs back; a tray would not, but a thumb needs to.
    tilt = { x: 0, y: 0 };
    paintDot();
  };
  tray.addEventListener("pointerup", release);
  tray.addEventListener("pointercancel", release);

  $("pad-zero").onclick = () => {
    if (raw) zero = { ...raw };
  };
  $("pad-tap").onclick = () => channel?.send({ t: "tap" });
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  if (source !== "tilt") setSource("tilt");
  raw = { beta: e.beta, gamma: e.gamma };
  if (!zero) zero = { ...raw };
  // Relative to "level", then turned to match how the screen is rotated,
  // so tilting toward the TV is "up" whichever way the phone is held.
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
  $("tray-dot").style.translate = `${tilt.x * 42}vmin ${tilt.y * 42}vmin`;
}

/* ---------- the wire ---------- */

function send() {
  // Rounded: three decimals is finer than any hand, and the frame is smaller.
  channel?.send(
    { t: "tilt", x: +tilt.x.toFixed(3), y: +tilt.y.toFixed(3) },
    true,
  );
}

function receive(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "hello" && /^#[0-9a-f]{6}$/i.test(m.colour)) {
    document.documentElement.style.setProperty("--me", m.colour);
  } else if (m.t === "bump") {
    const s = Math.max(0, Math.min(1, Number(m.s) || 0));
    // Android buzzes; iOS has no vibrate, so the tray flashes on both.
    navigator.vibrate?.(Math.round(15 + s * 45));
    const tray = $("tray");
    tray.classList.remove("hit");
    void tray.offsetWidth;
    tray.classList.add("hit");
  } else if (m.t === "path") {
    $("pad-path").textContent =
      m.path === "relay" ? "Connected via TURN relay" : "Connected directly";
  } else if (m.t === "full") {
    $("pad-error").textContent = "The screen is full.";
  }
}

/* A phone that locks mid-round stops sending; ask it not to. Every
 * reconnect calls this, and the listener only needs adding once. */
let awake = false;
function keepAwake() {
  if (awake) return;
  awake = true;
  const ask = async () => {
    try {
      if (document.visibilityState === "visible")
        await navigator.wakeLock?.request("screen");
    } catch {
      /* Refused or unsupported. */
    }
  };
  document.addEventListener("visibilitychange", ask);
  ask();
}
