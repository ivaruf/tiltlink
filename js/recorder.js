/*
 * recorder.js — record a 0.8 second attack sound on the phone.
 *
 * Raw samples straight off the microphone, not MediaRecorder: a recorder
 * hands back a file in this phone's own codec (WebM/Opus on Android, MP4/AAC
 * on an iPhone), which the TV's browser may not decode, and its start-up
 * lag would eat most of a 0.8 s window. Raw samples are captured from the
 * first moment and are the same on every phone.
 *
 * Capture uses a ScriptProcessorNode. It is deprecated in favour of
 * AudioWorklet, but it is a single node with no second file and it works in
 * every browser a phone runs; for one short take, its main-thread cost is
 * nothing. Swap it for a worklet if it ever goes away.
 *
 * The mic is held open only while the sound panel is open — close() stops
 * the tracks, so the phone's recording indicator goes off with the panel,
 * rather than hearing the room for the whole party. The clip never leaves
 * this phone except to the stage, over the encrypted data channel.
 *
 * What a take becomes (shape()):
 *   - trimmed to start just before the first loud sample, so the 0.8 s is
 *     the shout and not the breath before it
 *   - resampled to 16 kHz mono and levelled to one peak, so a whisper and a
 *     scream play at about the same volume on the TV
 *   - faded at both ends, so it does not click
 *   - Int16, 12,800 samples, 25.6 KB
 */

export const CLIP_SECONDS = 0.8;
export const CLIP_RATE = 16000;
const MAX_TAKE_SECONDS = 2;

let ctx = null;
let stream = null;
let source = null;
let processor = null;
let chunks = [];
let taking = false;
let takeLength = 0;

/* From a tap: opens the mic (asking the first time) and the audio context. */
export async function open() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!ctx && AC) ctx = new AC();
  ctx?.resume?.().catch(() => {});
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(isSecureContext ? "This browser cannot record." : "Recording needs HTTPS.");
  stream = await navigator.mediaDevices.getUserMedia({
    // Echo cancellation and noise suppression are for calls; on a shout they
    // chew the start off. Auto gain is fine — shape() levels it anyway.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  source = ctx.createMediaStreamSource(stream);
  processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!taking) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    takeLength += e.inputBuffer.length;
    if (takeLength > ctx.sampleRate * MAX_TAKE_SECONDS) taking = false;
  };
  // A processor only runs while connected to the output; a zero gain keeps
  // the mic out of the phone's own speaker.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(processor).connect(silent).connect(ctx.destination);
}

export function close() {
  taking = false;
  try {
    source?.disconnect();
    processor?.disconnect();
  } catch {
    /* Already gone. */
  }
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = source = processor = null;
}

export const isOpen = () => !!stream;

export function start() {
  chunks = [];
  takeLength = 0;
  taking = !!stream;
}

/* Stop and return the shaped clip, or throw a message for a person. */
export function stop() {
  taking = false;
  const raw = new Float32Array(takeLength);
  let at = 0;
  for (const c of chunks) {
    raw.set(c.subarray(0, Math.min(c.length, raw.length - at)), at);
    at += c.length;
    if (at >= raw.length) break;
  }
  chunks = [];
  return shape(raw, ctx.sampleRate);
}

function shape(raw, rate) {
  let peak = 0;
  for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]));
  if (peak < 0.02) throw new Error("Didn't hear anything — hold the button and shout!");

  // Onset: the first sample over a fraction of the peak, minus 15 ms.
  const threshold = Math.max(0.02, peak * 0.2);
  let onset = 0;
  while (onset < raw.length && Math.abs(raw[onset]) < threshold) onset++;
  onset = Math.max(0, onset - Math.round(rate * 0.015));

  // Resample by averaging each output sample's span of input: crude, but
  // it low-passes on the way down, which is all 16 kHz needs.
  const n = Math.round(CLIP_RATE * CLIP_SECONDS);
  const ratio = rate / CLIP_RATE;
  const out = new Float32Array(n);
  let outPeak = 0;
  for (let i = 0; i < n; i++) {
    const a = onset + Math.floor(i * ratio);
    const b = Math.max(a + 1, onset + Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = a; j < b && j < raw.length; j++) {
      sum += raw[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
    outPeak = Math.max(outPeak, Math.abs(out[i]));
  }

  // Level to one peak, but never boost more than 8×, or a quiet take turns
  // into amplified room hiss.
  const gain = Math.min(8, 0.9 / (outPeak || 1));
  const fadeIn = Math.round(CLIP_RATE * 0.004);
  const fadeOut = Math.round(CLIP_RATE * 0.04);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = out[i] * gain;
    if (i < fadeIn) v *= i / fadeIn;
    if (i > n - fadeOut) v *= (n - i) / fadeOut;
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return pcm;
}

/* Play a clip back on the phone itself, to hear what was kept. */
export function preview(pcm) {
  if (!ctx || !pcm) return;
  const buffer = ctx.createBuffer(1, pcm.length, CLIP_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
}

/*
 * Over the wire as base64 in chunks: the data channel takes JSON strings
 * here, and 25.6 KB is 34 KB of base64 — twice the 16 KB a data channel
 * message can be counted on to carry. Six chunks of 6,000 characters.
 */
const CHUNK = 6000;

export function toChunks(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const text = btoa(binary);
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  return parts;
}
