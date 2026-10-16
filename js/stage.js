/*
 * stage.js — the big screen.
 *
 * Takes a picture code, holds it at the broker, shows it as a QR and as
 * three pictures, and gives every phone that joins a ball. The phone sends
 * its tilt; the stage owns all the physics (host-authoritative, hub §8), so
 * a phone can only ever say "I am tilted this much", clamped, never "my ball
 * is here".
 *
 * Talks back too, on the reliable lane: the phone's colour on join, and a
 * "bump" when its ball hits a wall or another ball, which the phone turns
 * into a buzz. That is the round trip a party game will need, in miniature.
 */

import { newCode, codeIcons } from "./net/codes.js";
import { hostRendezvous } from "./net/rendezvous.js";
import { pathOf, haveTurn } from "./net/webrtc.js";

const COLOURS = [
  "#ff5c8a", "#4fd6ff", "#ffd23f", "#7cff6b",
  "#b18cff", "#ff8f3f", "#3fffd2", "#ff4bf0",
];
const MAX_PLAYERS = COLOURS.length;

/* Physics, in CSS pixels and seconds. Fixed step (hub §10). */
const STEP = 1 / 120;
const MAX_STEPS = 8;
const ACCEL = 2600; // full tilt
const DRAG = 1.6; // per second, so a ball coasts and then settles
const BOUNCE = 0.62;
const RADIUS = 34;
const BUMP_SPEED = 260; // slower than this is a nudge, not a bump
const BUMP_EVERY_MS = 120;

const players = new Map(); // id -> player
let canvas, ctx, width, height, dpr;
let last = 0;
let acc = 0;
let started = false;

export async function startStage() {
  if (started) return;
  started = true;
  canvas = document.getElementById("arena");
  ctx = canvas.getContext("2d");
  addEventListener("resize", resize);
  resize();
  keepAwake();
  requestAnimationFrame(frame);
  setInterval(refreshPaths, 2000);
  await open();
}

/* ---------- the room ---------- */

async function open() {
  const status = document.getElementById("stage-status");
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
  const icons = codeIcons(code);
  document.getElementById("code-icons").textContent = icons.join(" ");
  document.getElementById("code-names").textContent = code.split("-").join(" · ");
  document.getElementById("join-url").textContent = url;

  const notes = [];
  if (room.mode === "tabs")
    notes.push(`No matchmaker (${room.detail}) — only tabs in this browser can join.`);
  else notes.push(haveTurn ? "Matchmaker up · TURN relay ready" : "Matchmaker up · STUN only (no relay)");
  // The QR carries this page's own address. localhost means nothing to a
  // phone, so say so rather than letting someone scan a dead link.
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname))
    notes.push("This is localhost: phones can't open it. Use the Mac's LAN IP or the Pages URL.");
  if (!isSecureContext || location.protocol !== "https:")
    notes.push("Not HTTPS: phones will get a drag pad instead of tilt.");
  document.getElementById("stage-status").textContent = notes.join("\n");
}

function drawQR(text) {
  const qr = window.qrcode?.(0, "M");
  const target = document.getElementById("qr");
  if (!qr) {
    target.hidden = true;
    return;
  }
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3; // light margin, so a dark page around it does not confuse a reader
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

function onPeer(id, channel) {
  // A phone that reloaded comes back with a new id; the old one closes
  // itself when its connection drops.
  if (players.size >= MAX_PLAYERS) {
    channel.send({ t: "full" });
    setTimeout(() => channel.close(), 500);
    return;
  }
  const colour = COLOURS.find((c) => ![...players.values()].some((p) => p.colour === c));
  const player = {
    id,
    channel,
    colour,
    x: width / 2 + (Math.random() - 0.5) * 200,
    y: height / 2 + (Math.random() - 0.5) * 200,
    vx: 0,
    vy: 0,
    tx: 0,
    ty: 0,
    pulse: 0,
    lastBump: 0,
    path: "",
    seen: performance.now(),
  };
  players.set(id, player);
  channel.onMessage = (m) => receive(player, m);
  channel.onClose = () => {
    players.delete(id);
    renderRoster();
  };
  channel.send({ t: "hello", colour });
  renderRoster();
  refreshPaths();
}

/* Validate everything: a phone may say how it is tilted and that it tapped. */
function receive(player, m) {
  if (!m || typeof m !== "object") return;
  player.seen = performance.now();
  if (m.t === "tilt") {
    const x = Number(m.x);
    const y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    player.tx = Math.max(-1, Math.min(1, x));
    player.ty = Math.max(-1, Math.min(1, y));
  } else if (m.t === "tap") {
    player.pulse = 1;
    // A hop in the direction it is already rolling, so a tap feels like
    // something rather than only a ring.
    const speed = Math.hypot(player.vx, player.vy) || 1;
    player.vx += (player.vx / speed) * 420;
    player.vy += (player.vy / speed) * 420;
  }
}

async function refreshPaths() {
  let changed = false;
  for (const p of players.values()) {
    const path = await pathOf(p.channel.connection);
    if (path && path !== p.path) {
      p.path = path;
      changed = true;
      p.channel.send({ t: "path", path });
    }
  }
  if (changed) renderRoster();
}

function renderRoster() {
  const list = document.getElementById("roster");
  list.replaceChildren(
    ...[...players.values()].map((p, i) => {
      const li = document.createElement("li");
      li.style.setProperty("--c", p.colour);
      li.textContent = `Phone ${i + 1}`;
      if (p.path) {
        const tag = document.createElement("span");
        tag.className = `path ${p.path}`;
        tag.textContent = p.path === "relay" ? "via TURN" : "direct";
        li.append(tag);
      }
      return li;
    }),
  );
  document.getElementById("empty-hint").hidden = players.size > 0;
  document.getElementById("join-card").classList.toggle("small", players.size > 0);
}

/* ---------- simulation ---------- */

function bump(p, strength, now) {
  if (now - p.lastBump < BUMP_EVERY_MS) return;
  p.lastBump = now;
  p.channel.send({ t: "bump", s: Math.min(1, strength) });
}

function step(now) {
  const list = [...players.values()];
  const damp = Math.exp(-DRAG * STEP);
  for (const p of list) {
    p.vx = (p.vx + p.tx * ACCEL * STEP) * damp;
    p.vy = (p.vy + p.ty * ACCEL * STEP) * damp;
    p.x += p.vx * STEP;
    p.y += p.vy * STEP;
    p.pulse = Math.max(0, p.pulse - STEP * 2.5);
    // Walls.
    for (const [pos, vel, lo, hi] of [
      ["x", "vx", RADIUS, width - RADIUS],
      ["y", "vy", RADIUS, height - RADIUS],
    ]) {
      if (p[pos] < lo || p[pos] > hi) {
        const hit = Math.abs(p[vel]);
        p[pos] = p[pos] < lo ? lo : hi;
        p[vel] = -p[vel] * BOUNCE;
        if (hit > BUMP_SPEED) bump(p, hit / 1800, now);
      }
    }
  }
  // Balls against balls: equal masses, push apart, swap the normal speed.
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d >= RADIUS * 2) continue;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = RADIUS * 2 - d;
      a.x -= (nx * overlap) / 2;
      a.y -= (ny * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.y += (ny * overlap) / 2;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel <= 0) continue;
      const k = rel * (0.5 + BOUNCE / 2);
      a.vx -= k * nx;
      a.vy -= k * ny;
      b.vx += k * nx;
      b.vy += k * ny;
      if (rel > BUMP_SPEED) {
        bump(a, rel / 1800, now);
        bump(b, rel / 1800, now);
      }
    }
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, last ? (t - last) / 1000 : 0);
  last = t;
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < MAX_STEPS) {
    step(t);
    acc -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;
  draw(t);
}

/* ---------- drawing ---------- */

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth;
  height = innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  for (const p of players.values()) {
    p.x = Math.min(Math.max(p.x, RADIUS), width - RADIUS);
    p.y = Math.min(Math.max(p.y, RADIUS), height - RADIUS);
  }
}

function draw(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e1a";
  ctx.fillRect(0, 0, width, height);
  // A faint grid, so motion reads even with one ball.
  ctx.strokeStyle = "rgba(120,140,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x += 48) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y < height; y += 48) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();

  for (const p of players.values()) {
    // Tilt arrow: what the phone is asking for, separate from where it is.
    ctx.strokeStyle = p.colour;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.tx * 90, p.y + p.ty * 90);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (p.pulse > 0) {
      ctx.strokeStyle = p.colour;
      ctx.globalAlpha = p.pulse;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS + (1 - p.pulse) * 70, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.shadowColor = p.colour;
    ctx.shadowBlur = 24;
    ctx.fillStyle = p.colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Gone quiet for two seconds: dim it, so a sleeping phone is visible.
    if (t - p.seen > 2000) {
      ctx.fillStyle = "rgba(11,14,26,0.6)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* A TV that dims mid-party drops off the broker; ask it not to. */
async function keepAwake() {
  const ask = async () => {
    try {
      if (document.visibilityState === "visible")
        await navigator.wakeLock?.request("screen");
    } catch {
      /* Refused or unsupported; the broker beat in rendezvous.js covers it. */
    }
  };
  document.addEventListener("visibilitychange", ask);
  ask();
}
