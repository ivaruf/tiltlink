/*
 * stage.js — the big screen: the room, the panels, and the wire.
 *
 * Takes a picture code, holds it at the broker and shows it as a QR. Every
 * phone that joins becomes a blob in arena.js, which owns the fight; this
 * file turns phone messages into arena calls and arena events into phone
 * messages and sounds.
 *
 * What a phone may say, all validated here (hub §8 — a guest must not be
 * able to claim its own state):
 *   tilt {x, y}       clamped to −1…1, non-finite dropped
 *   tap               a pulse request; arena.js enforces the cooldown
 *   clip {i, n, d}    one base64 chunk of its 0.4 s attack sound
 *
 * What it hears back: hello (its colour and name), phase, you (lives),
 * pulsed (start your cooldown), hit, bump, path (direct or TURN), clip-ok.
 */

import { newCode, codeIcons } from "./net/codes.js";
import { hostRendezvous } from "./net/rendezvous.js";
import { pathOf, haveTurn } from "./net/webrtc.js";
import * as arena from "./arena.js";
import * as sound from "./sound.js";

/* Names are what the screen calls you ("Pink wins!"), so each colour has one. */
const SEATS = [
  { colour: "#ff5c8a", name: "Pink" },
  { colour: "#4fd6ff", name: "Blue" },
  { colour: "#ffd23f", name: "Yellow" },
  { colour: "#7cff6b", name: "Green" },
  { colour: "#b18cff", name: "Purple" },
  { colour: "#ff8f3f", name: "Orange" },
  { colour: "#3fffd2", name: "Teal" },
  { colour: "#ff4bf0", name: "Magenta" },
];
const MAX_BOTS = 8;
const MAX_STEPS = 8;
// A shaped clip is 6,400 Int16 samples (recorder.js); allow a little slack
// and refuse anything bigger rather than trusting the phone's arithmetic.
const MAX_CLIP_BYTES = 6400 * 2 + 64;

const $ = (id) => document.getElementById(id);
const phones = new Map(); // id -> { channel, blob, seat, path, parts }
let canvas, ctx, width, height, dpr;
let last = 0;
let acc = 0;
let started = false;
let bots = 2;

export async function startStage() {
  if (started) return;
  started = true;
  // We are inside the click that chose "big screen", so audio may start.
  sound.unlock();
  addEventListener("pointerdown", sound.unlock);
  canvas = $("arena");
  ctx = canvas.getContext("2d");
  addEventListener("resize", resize);
  resize();
  wirePanels();
  arena.hooks.onPulse = onPulse;
  arena.hooks.onHit = onHit;
  arena.hooks.onOut = onOut;
  arena.hooks.onBump = (blob, s) => phoneOf(blob)?.channel.send({ t: "bump", s });
  arena.hooks.onPhase = onPhase;
  arena.setBots(bots);
  onPhase("lobby", null);
  keepAwake();
  requestAnimationFrame(frame);
  setInterval(refreshPaths, 2000);
  await open();
}

/* ---------- the room ---------- */

async function open() {
  const status = $("stage-status");
  status.textContent = "Getting a code…";
  // A taken code is someone else's room right now; draw another.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      const room = await hostRendezvous(code, onPeer);
      showCode(code, room);
      return;
    } catch (error) {
      if (!error.taken) {
        status.textContent = error.message;
        return;
      }
    }
  }
  status.textContent = "Could not get a free code. Reload to try again.";
}

function showCode(code, room) {
  const url = `${location.origin}${location.pathname}#join=${code}`;
  drawQR(url);
  $("code-icons").textContent = codeIcons(code).join(" ");
  $("code-names").textContent = code.split("-").join(" · ");
  $("join-url").textContent = url;

  const notes = [];
  if (room.mode === "tabs")
    notes.push(`No matchmaker (${room.detail}) — only tabs in this browser can join.`);
  else notes.push(haveTurn ? "Matchmaker up · TURN relay ready" : "Matchmaker up · STUN only (no relay)");
  // The QR carries this page's own address; localhost means nothing to a phone.
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname))
    notes.push("This is localhost: phones can't open it. Use the Mac's LAN IP or the Pages URL.");
  if (location.protocol !== "https:")
    notes.push("Not HTTPS: phones get a drag pad instead of tilt, and can't record.");
  $("stage-status").textContent = notes.join("\n");
}

function drawQR(text) {
  const qr = window.qrcode?.(0, "M");
  const target = $("qr");
  if (!qr) {
    target.hidden = true;
    return;
  }
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3; // a light margin, so the dark page around it confuses no reader
  const cell = Math.floor(target.width / (n + quiet * 2));
  const off = Math.floor((target.width - cell * n) / 2);
  const g = target.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, target.width, target.height);
  g.fillStyle = "#0b0e1a";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) g.fillRect(off + c * cell, off + r * cell, cell, cell);
}

/* ---------- phones ---------- */

const phoneOf = (blob) => (blob?.kind === "phone" ? phones.get(blob.id) : null);

function onPeer(id, channel) {
  const taken = new Set([...phones.values()].map((p) => p.seat));
  const seat = SEATS.find((s) => !taken.has(s));
  if (!seat) {
    channel.send({ t: "full" });
    setTimeout(() => channel.close(), 500);
    return;
  }
  const blob = arena.addBlob({ id, kind: "phone", colour: seat.colour, label: seat.name });
  const phone = { channel, blob, seat, path: "", parts: null };
  phones.set(id, phone);
  channel.onMessage = (m) => receive(phone, m);
  channel.onClose = () => {
    phones.delete(id);
    arena.removeBlob(blob);
    renderRoster();
    renderLobby();
  };
  channel.send({ t: "hello", colour: seat.colour, name: seat.name });
  channel.send({ t: "phase", phase: arena.phase });
  sendLives(blob);
  renderRoster();
  renderLobby();
  refreshPaths();
}

function receive(phone, m) {
  if (!m || typeof m !== "object") return;
  const blob = phone.blob;
  blob.seen = performance.now();
  if (m.t === "tilt") {
    const x = Number(m.x);
    const y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    blob.tx = Math.max(-1, Math.min(1, x));
    blob.ty = Math.max(-1, Math.min(1, y));
  } else if (m.t === "tap") {
    arena.pulse(blob);
  } else if (m.t === "clip") {
    takeClipPart(phone, m);
  }
}

/* Chunks arrive in order on the reliable lane; assemble, check, decode. */
function takeClipPart(phone, m) {
  const n = Number(m.n);
  const i = Number(m.i);
  if (!Number.isInteger(n) || n < 1 || n > 4) return;
  if (!Number.isInteger(i) || i < 0 || i >= n) return;
  if (typeof m.d !== "string" || m.d.length > 8000) return;
  if (i === 0) phone.parts = [];
  if (!phone.parts || phone.parts.length !== i) return; // out of step; wait for a fresh i=0
  phone.parts.push(m.d);
  if (phone.parts.length < n) return;
  const text = phone.parts.join("");
  phone.parts = null;
  let binary;
  try {
    binary = atob(text);
  } catch {
    return;
  }
  if (binary.length > MAX_CLIP_BYTES || binary.length % 2) return;
  const bytes = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k);
  phone.blob.clip = sound.clipBuffer(new Int16Array(bytes.buffer));
  if (!phone.blob.clip) return;
  phone.channel.send({ t: "clip-ok" });
  renderRoster();
}

function sendLives(blob) {
  phoneOf(blob)?.channel.send({ t: "you", lives: blob.lives, alive: blob.alive });
}

/* ---------- arena events ---------- */

function onPulse(blob) {
  sound.playPulse(blob);
  phoneOf(blob)?.channel.send({ t: "pulsed", cooldown: arena.COOLDOWN });
}

function onHit(attacker, victim) {
  sound.playHit();
  phoneOf(victim)?.channel.send({ t: "hit" });
  sendLives(victim);
  if (victim.kind === "phone") renderRoster();
}

function onOut(blob) {
  sound.playPop();
  sendLives(blob);
}

function onPhase(phase, winner) {
  $("lobby-panel").hidden = phase !== "lobby";
  $("over-panel").hidden = phase !== "over";
  // The join card is for between rounds; mid-fight it is in the way.
  $("join-card").hidden = phase === "play";
  if (phase === "over") {
    $("over-title").textContent = winner ? `${winner.label === "bot" ? "A bot" : winner.label} wins!` : "Nobody wins!";
    $("over-title").style.color = winner?.colour ?? "";
  }
  for (const phone of phones.values()) {
    const won = phase === "over" && winner === phone.blob;
    phone.channel.send({ t: "phase", phase, won });
    sendLives(phone.blob);
  }
  renderRoster();
  renderLobby();
}

/* ---------- panels ---------- */

function wirePanels() {
  $("bots-less").onclick = () => setBots(bots - 1);
  $("bots-more").onclick = () => setBots(bots + 1);
  $("start").onclick = () => arena.startRound();
  $("rematch").onclick = () => arena.startRound();
  $("to-lobby").onclick = () => arena.toLobby();
}

function setBots(n) {
  bots = Math.max(0, Math.min(MAX_BOTS, n));
  arena.setBots(bots);
  renderLobby();
}

function renderLobby() {
  $("bots-count").textContent = String(bots);
  $("bots-less").disabled = bots <= 0;
  $("bots-more").disabled = bots >= MAX_BOTS;
  // A fight needs two blobs, and at least one of them should be a person.
  const ready = phones.size >= 1 && arena.blobs.length >= 2;
  $("start").disabled = !ready;
  $("lobby-note").textContent =
    phones.size === 0
      ? "Waiting for phones…"
      : arena.blobs.length < 2
        ? "Add a bot or another phone to fight."
        : "Practise now: pulses push but don't hurt yet.";
}

function renderRoster() {
  const list = $("roster");
  list.replaceChildren(
    ...[...phones.values()].map((p) => {
      const li = document.createElement("li");
      li.style.setProperty("--c", p.seat.colour);
      const name = document.createElement("span");
      name.className = "who";
      name.textContent = p.seat.name;
      li.append(name);
      if (arena.phase !== "lobby") {
        const lives = document.createElement("span");
        lives.className = "lives";
        lives.textContent = p.blob.alive ? `♥ ${p.blob.lives}` : "out";
        li.append(lives);
      }
      if (p.path) {
        const tag = document.createElement("span");
        tag.className = `path ${p.path}`;
        tag.textContent = p.path === "relay" ? "via TURN" : "direct";
        li.append(tag);
      }
      // Their recorded sound plays in this room, so this room can mute it.
      if (p.blob.clip) {
        const mute = document.createElement("button");
        mute.className = "mute";
        mute.setAttribute("aria-pressed", String(!!p.blob.muted));
        mute.textContent = p.blob.muted ? "sound off" : "sound on";
        mute.title = `Mute ${p.seat.name}'s recorded sound`;
        mute.onclick = () => {
          p.blob.muted = !p.blob.muted;
          renderRoster();
        };
        li.append(mute);
      }
      return li;
    }),
  );
  $("join-card").classList.toggle("small", phones.size > 0);
}

async function refreshPaths() {
  let changed = false;
  for (const p of phones.values()) {
    const path = await pathOf(p.channel.connection);
    if (path && path !== p.path) {
      p.path = path;
      changed = true;
      p.channel.send({ t: "path", path });
    }
  }
  if (changed) renderRoster();
}

/* ---------- the loop ---------- */

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, last ? (t - last) / 1000 : 0);
  last = t;
  acc += dt;
  let steps = 0;
  while (acc >= arena.STEP && steps < MAX_STEPS) {
    arena.step();
    acc -= arena.STEP;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  arena.draw(ctx, t);
}

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth;
  height = innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  arena.setSize(width, height);
}

/* A TV that dims mid-party drops off the broker; ask it not to. */
function keepAwake() {
  const ask = async () => {
    try {
      if (document.visibilityState === "visible") await navigator.wakeLock?.request("screen");
    } catch {
      /* Refused or unsupported; the broker beat in rendezvous.js covers it. */
    }
  };
  document.addEventListener("visibilitychange", ask);
  ask();
}
