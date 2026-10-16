/*
 * arena.js — the blobs, the fight, and the bots.
 *
 * Everything the stage simulates lives here; stage.js only wires phones to
 * blobs and draws the panels around it. The stage is authoritative (hub §8):
 * a phone says how it is tilted and that it pulsed, and this file decides
 * what that did.
 *
 * THE FIGHT. A pulse is a shockwave of radius RANGE around the blob. Every
 * other blob inside it is knocked away and, in a round, loses a life. Range
 * is a little over one blob-width of clear air, so landing a hit means
 * steering in close enough to be hit back — that tension is the game. The
 * cooldown is enforced here, not on the phone, so a modified phone cannot
 * machine-gun; the phone only mirrors it so its button can show it.
 *
 * Three phases:
 *   lobby  everyone rolls about and pulses for practice — knockback, no damage
 *   play   lives count; last blob alive wins
 *   over   the winner is announced; things coast until a rematch
 *
 * Bots are blobs with no phone: same physics, same pulse, same cooldown, so
 * they cannot do anything a player cannot. They are deliberately a bit slow
 * on the trigger and wobble as they steer, so a kid can beat them.
 */

export const RADIUS = 30;
export const LIVES = 10;
export const COOLDOWN = 0.8; // seconds between pulses
export const RANGE = RADIUS * 3.3; // centre to centre

const ACCEL = 2600; // full tilt, px/s²
const DRAG = 1.6; // per second
const BOUNCE = 0.62;
const KNOCK = 820; // px/s shove from a pulse
const SAFE_AFTER_HIT = 0.4; // seconds of grace, so one pulse is one life
const BUMP_SPEED = 260;
const BUMP_EVERY = 0.12;

const BOT_COLOURS = ["#8a93b8", "#b8a58a", "#8ab8a0", "#b88aa8", "#a0a0a0", "#8aa8b8", "#b8b08a", "#a88ab8"];

export const blobs = [];
export let phase = "lobby";
let width = 800;
let height = 600;
let now = 0; // simulation clock, seconds
let botSerial = 0;

/* Stage-provided reactions. Each is optional. */
export const hooks = {
  onPulse: null, // (blob)
  onHit: null, // (attacker, victim)
  onOut: null, // (blob)
  onBump: null, // (blob, strength 0..1)
  onPhase: null, // (phase, winner | null)
};

export function setSize(w, h) {
  width = w;
  height = h;
  for (const b of blobs) {
    b.x = clamp(b.x, RADIUS, width - RADIUS);
    b.y = clamp(b.y, RADIUS, height - RADIUS);
  }
}

/* A new blob, dropped somewhere clear-ish. A phone that joins mid-round
 * watches until the next one rather than dropping in with ten fresh lives. */
export function addBlob({ id, kind, colour, label }) {
  const blob = {
    id,
    kind,
    colour,
    label,
    x: RADIUS + Math.random() * (width - 2 * RADIUS),
    y: RADIUS + Math.random() * (height - 2 * RADIUS),
    vx: 0,
    vy: 0,
    tx: 0,
    ty: 0,
    lives: LIVES,
    alive: phase !== "play",
    ready: 0, // sim time the next pulse is allowed
    safe: 0, // sim time hits count again
    ring: 0, // pulse animation, 1 → 0
    hurt: 0, // hit flash, 1 → 0
    lastBump: 0,
    seen: performance.now(),
    ai: kind === "bot" ? newBrain() : null,
  };
  blobs.push(blob);
  return blob;
}

export function removeBlob(blob) {
  const i = blobs.indexOf(blob);
  if (i >= 0) blobs.splice(i, 1);
  if (phase === "play") checkWinner();
}

export const botCount = () => blobs.filter((b) => b.kind === "bot").length;

/* Add or remove bots until there are n. Only between rounds. */
export function setBots(n) {
  if (phase === "play") return;
  while (botCount() < n) {
    botSerial++;
    addBlob({
      id: `bot-${botSerial}`,
      kind: "bot",
      colour: BOT_COLOURS[(botSerial - 1) % BOT_COLOURS.length],
      label: "bot",
    });
  }
  while (botCount() > n) {
    const last = blobs.findLast((b) => b.kind === "bot");
    removeBlob(last);
  }
}

/* Everyone back to ten lives, spread round a circle, and fight. */
export function startRound() {
  const n = blobs.length;
  const r = Math.min(width, height) * 0.36;
  blobs.forEach((b, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    b.x = width / 2 + Math.cos(a) * r;
    b.y = height / 2 + Math.sin(a) * r;
    b.vx = b.vy = 0;
    b.lives = LIVES;
    b.alive = true;
    b.ready = now + 0.6; // nobody fires on the first frame
    b.safe = 0;
    b.hurt = 0;
    if (b.ai) b.ai = newBrain();
  });
  setPhase("play", null);
}

export function toLobby() {
  for (const b of blobs) {
    b.alive = true;
    b.lives = LIVES;
  }
  setPhase("lobby", null);
}

function setPhase(next, winner) {
  phase = next;
  hooks.onPhase?.(next, winner);
}

function checkWinner() {
  const alive = blobs.filter((b) => b.alive);
  if (alive.length <= 1) setPhase("over", alive[0] ?? null);
}

/* ---------- the pulse ---------- */

/* Returns true if it fired. The cooldown lives here, whoever is asking. */
export function pulse(blob) {
  if (!blob.alive || now < blob.ready || phase === "over") return false;
  blob.ready = now + COOLDOWN;
  blob.ring = 1;
  hooks.onPulse?.(blob);
  for (const other of blobs) {
    if (other === blob || !other.alive) continue;
    const dx = other.x - blob.x;
    const dy = other.y - blob.y;
    const d = Math.hypot(dx, dy);
    if (d > RANGE) continue;
    const nx = d ? dx / d : 1;
    const ny = d ? dy / d : 0;
    other.vx += nx * KNOCK;
    other.vy += ny * KNOCK;
    if (phase !== "play" || now < other.safe) continue;
    other.lives -= 1;
    other.safe = now + SAFE_AFTER_HIT;
    other.hurt = 1;
    hooks.onHit?.(blob, other);
    if (other.lives <= 0) {
      other.alive = false;
      burst(other);
      hooks.onOut?.(other);
    }
  }
  if (phase === "play") checkWinner();
  return true;
}

export const cooldownLeft = (blob) => Math.max(0, blob.ready - now);

/* ---------- bots ---------- */

function newBrain() {
  return {
    retarget: 0,
    target: null,
    wander: { x: 0, y: 0 },
    inRangeSince: -1,
    // Each bot its own reflexes and its own wobble, so a pack of them does
    // not move like one animal.
    reaction: 0.2 + Math.random() * 0.3,
    seed: Math.random() * 100,
  };
}

function think(bot) {
  const ai = bot.ai;
  if (now >= ai.retarget) {
    ai.retarget = now + 0.25 + Math.random() * 0.15;
    if (phase === "play") {
      let best = null;
      let bestD = Infinity;
      for (const b of blobs) {
        if (b === bot || !b.alive) continue;
        const d = Math.hypot(b.x - bot.x, b.y - bot.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      ai.target = best;
    } else {
      ai.target = null;
      ai.wander.x = RADIUS * 3 + Math.random() * (width - RADIUS * 6);
      ai.wander.y = RADIUS * 3 + Math.random() * (height - RADIUS * 6);
    }
  }
  const goal = ai.target ?? ai.wander;
  let dx = goal.x - bot.x;
  let dy = goal.y - bot.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  // Wobble across the line of approach, and lean off the walls.
  const w = Math.sin(now * 2.3 + ai.seed) * 0.45;
  let gx = (dx - dy * w) * (ai.target ? 0.8 : 0.4);
  let gy = (dy + dx * w) * (ai.target ? 0.8 : 0.4);
  const edge = RADIUS * 3;
  if (bot.x < edge) gx += 0.6;
  if (bot.x > width - edge) gx -= 0.6;
  if (bot.y < edge) gy += 0.6;
  if (bot.y > height - edge) gy -= 0.6;
  // Smoothly, like a hand on a phone rather than a switch.
  bot.tx += (clamp(gx, -1, 1) - bot.tx) * 0.08;
  bot.ty += (clamp(gy, -1, 1) - bot.ty) * 0.08;

  if (phase === "play" && ai.target && d < RANGE * 0.85) {
    if (ai.inRangeSince < 0) ai.inRangeSince = now;
    if (now - ai.inRangeSince > ai.reaction && pulse(bot)) ai.inRangeSince = -1;
  } else ai.inRangeSince = -1;
}

/* ---------- physics ---------- */

export const STEP = 1 / 120;

export function step() {
  now += STEP;
  const damp = Math.exp(-DRAG * STEP);
  for (const b of blobs) {
    b.ring = Math.max(0, b.ring - STEP * 3);
    b.hurt = Math.max(0, b.hurt - STEP * 3);
    if (!b.alive) continue;
    if (b.ai) think(b);
    b.vx = (b.vx + b.tx * ACCEL * STEP) * damp;
    b.vy = (b.vy + b.ty * ACCEL * STEP) * damp;
    b.x += b.vx * STEP;
    b.y += b.vy * STEP;
    for (const [pos, vel, lo, hi] of [
      ["x", "vx", RADIUS, width - RADIUS],
      ["y", "vy", RADIUS, height - RADIUS],
    ]) {
      if (b[pos] < lo || b[pos] > hi) {
        const hit = Math.abs(b[vel]);
        b[pos] = b[pos] < lo ? lo : hi;
        b[vel] = -b[vel] * BOUNCE;
        if (hit > BUMP_SPEED) bump(b, hit / 1800);
      }
    }
  }
  // Blob against blob: equal masses, push apart, trade the normal speed.
  for (let i = 0; i < blobs.length; i++) {
    const a = blobs[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < blobs.length; j++) {
      const b = blobs[j];
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d >= RADIUS * 2) continue;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = (RADIUS * 2 - d) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel <= 0) continue;
      const k = rel * (0.5 + BOUNCE / 2);
      a.vx -= k * nx;
      a.vy -= k * ny;
      b.vx += k * nx;
      b.vy += k * ny;
      if (rel > BUMP_SPEED) {
        bump(a, rel / 1800);
        bump(b, rel / 1800);
      }
    }
  }
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= STEP;
    p.x += p.vx * STEP;
    p.y += p.vy * STEP;
    p.vx *= 0.985;
    p.vy *= 0.985;
  }
}

function bump(b, strength) {
  if (now - b.lastBump < BUMP_EVERY) return;
  b.lastBump = now;
  hooks.onBump?.(b, Math.min(1, strength));
}

/* ---------- the pop ---------- */

/* A fixed pool, so popping a blob allocates nothing mid-round (hub §10). */
const particles = Array.from({ length: 160 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, colour: "" }));
let nextParticle = 0;

function burst(b) {
  for (let i = 0; i < 40; i++) {
    const p = particles[nextParticle];
    nextParticle = (nextParticle + 1) % particles.length;
    const a = Math.random() * Math.PI * 2;
    const s = 150 + Math.random() * 450;
    p.x = b.x;
    p.y = b.y;
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.life = 0.5 + Math.random() * 0.5;
    p.colour = b.colour;
  }
}

/* ---------- drawing ---------- */

export function draw(ctx, wallClock) {
  ctx.fillStyle = "#0b0e1a";
  ctx.fillRect(0, 0, width, height);
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

  for (const p of particles) {
    if (p.life <= 0) continue;
    ctx.globalAlpha = Math.min(1, p.life * 2);
    ctx.fillStyle = p.colour;
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.globalAlpha = 1;

  for (const b of blobs) {
    // The ring grows to exactly RANGE, so watching a pulse teaches its reach.
    if (b.ring > 0) {
      ctx.strokeStyle = b.colour;
      ctx.globalAlpha = b.ring;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, RADIUS + (1 - b.ring) * (RANGE - RADIUS), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (!b.alive) continue;

    const flashing = b.hurt > 0 && Math.floor(b.hurt * 12) % 2 === 0;
    ctx.shadowColor = b.colour;
    ctx.shadowBlur = b.kind === "bot" ? 8 : 24;
    ctx.fillStyle = flashing ? "#ffffff" : b.colour;
    ctx.beginPath();
    ctx.arc(b.x, b.y, RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Eyes that look where the blob is going.
    const speed = Math.hypot(b.vx, b.vy);
    const lx = speed > 20 ? b.vx / speed : 0;
    const ly = speed > 20 ? b.vy / speed : 0;
    for (const side of [-1, 1]) {
      const ex = b.x + side * RADIUS * 0.36 + lx * 4;
      const ey = b.y - RADIUS * 0.15 + ly * 4;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(ex, ey, RADIUS * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0b0e1a";
      ctx.beginPath();
      ctx.arc(ex + lx * 4, ey + ly * 4, RADIUS * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Lives as pips in an arc above, in a round only.
    if (phase !== "lobby") {
      for (let i = 0; i < LIVES; i++) {
        const a = -Math.PI / 2 + (i - (LIVES - 1) / 2) * 0.2;
        ctx.fillStyle = i < b.lives ? b.colour : "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(a) * (RADIUS + 12), b.y + Math.sin(a) * (RADIUS + 12), 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (b.kind === "bot") {
      ctx.fillStyle = "rgba(238,240,255,0.55)";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("bot", b.x, b.y + RADIUS + 16);
    }

    // A phone gone quiet for two seconds is dimmed, so a locked one shows.
    if (b.kind === "phone" && wallClock - b.seen > 2000) {
      ctx.fillStyle = "rgba(11,14,26,0.6)";
      ctx.beginPath();
      ctx.arc(b.x, b.y, RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
