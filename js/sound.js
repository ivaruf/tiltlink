/*
 * sound.js — the big screen's speaker.
 *
 * Every pulse plays its blob's sound: the 0.4 s clip its player recorded on
 * their phone (pad.js / recorder.js), or a synthesised "whomp" for bots and
 * for players who have not recorded one. Hits and pops are synthesised too.
 *
 * Runtime WebAudio rather than Sonic Pi (hub §9) on purpose, and for two
 * reasons: the recorded clips only exist at runtime, and this is a tech
 * demo whose stock sounds are placeholders. If TiltLink grows into a game,
 * the whomp/hit/pop become composed files and only the clips stay here.
 *
 * Everything goes through one limiter, because a player's clip is whatever
 * they shouted into their phone. The phone already levels it (recorder.js);
 * this is the backstop between eight excited children and the TV speakers.
 *
 * A clip arrives as 16 kHz mono Int16 PCM rather than in the phone's own
 * codec, so the TV never has to decode a format its browser may not know —
 * Android records WebM/Opus, iPhones MP4/AAC.
 */

export const CLIP_RATE = 16000;

let ctx = null;
let out = null;

/* Call from a click: browsers only let a gesture start audio. */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    out = ctx.createGain();
    out.gain.value = 0.8;
    out.connect(limiter).connect(ctx.destination);
  }
  ctx.resume?.().catch(() => {});
}

/* Int16 PCM at CLIP_RATE → a playable buffer, or null. */
export function clipBuffer(int16) {
  if (!ctx || !int16?.length) return null;
  const buffer = ctx.createBuffer(1, int16.length, CLIP_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 32768;
  return buffer;
}

export function playPulse(blob) {
  if (!ctx) return;
  if (blob.clip && !blob.muted) {
    const src = ctx.createBufferSource();
    src.buffer = blob.clip;
    // A little pitch scatter, so ten pulses in a row are not one sample
    // played ten times.
    src.playbackRate.value = 0.92 + Math.random() * 0.18;
    src.connect(out);
    src.start();
    return;
  }
  // Whomp: a falling sine with a soft thump on the front.
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(blob.kind === "bot" ? 180 : 240, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.22);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(blob.kind === "bot" ? 0.25 : 0.45, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
}

export function playHit() {
  if (!ctx) return;
  noiseBurst(0.08, 1800, 0.35);
}

export function playPop() {
  if (!ctx) return;
  noiseBurst(0.35, 600, 0.6);
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(520, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.4);
  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.5);
}

/* One noise buffer, made once and reused for every burst. */
let noise = null;
function noiseBurst(seconds, cutoff, level) {
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  src.connect(filter).connect(gain).connect(out);
  src.start(t);
  src.stop(t + seconds + 0.02);
}
