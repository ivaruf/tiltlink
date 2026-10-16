/*
 * codes.js — room codes made of pictures.
 *
 * A code is the one thing a player has to carry from one device to another,
 * and it is carried by whoever is worst at typing. So it is three pictures,
 * not six letters: "fox-star-key" is what a kid taps on a grid of twelve
 * buttons and what a parent pastes into a chat, and nothing has to be
 * translated between the two. Read aloud it is three ordinary words rather
 * than "F, X as in x-ray, seven...".
 *
 * Twelve pictures, three slots, so 1,728 codes. That is a small space on
 * purpose. Only rooms open at this moment can collide, there are a handful at
 * most, and the rendezvous reports a taken code and hands out another rather
 * than failing silently — against which, a third fewer taps for the player
 * for whom every tap is the hard part. The instinct on reading 1,728 is to
 * widen it; the arithmetic is here so that instinct has something to argue
 * with. (The shape of this is fishtank's, and it earned it.)
 *
 * One thing per category is the whole selection rule: an animal, a bird, an
 * insect, two vehicles that look nothing alike, food, a plant, a shape, and
 * four plain objects. No two are the same kind of thing, the same silhouette
 * or the same colour, because at button size "which fish was it again?" is a
 * player who cannot use the code.
 *
 * Emoji, not artwork: already in the system font on every device that runs
 * this, no download and no third party (hub CLAUDE.md §1). Every one is
 * Unicode 9 or older and a single code point, so an old tablet shows a
 * picture rather than a box and counting characters counts pictures.
 *
 * Names are short words a small child already owns, and every one is unique
 * in its first two letters, which is what lets the parser below accept a
 * half-remembered spelling.
 */

export const SYMBOLS = Object.freeze(
  [
    { name: "fox", icon: "🦊" },
    { name: "duck", icon: "🦆" },
    { name: "bee", icon: "🐝" },
    { name: "car", icon: "🚗" },
    { name: "rocket", icon: "🚀" },
    { name: "pizza", icon: "🍕" },
    { name: "tree", icon: "🌲" },
    { name: "star", icon: "⭐" },
    { name: "moon", icon: "🌙" },
    { name: "key", icon: "🔑" },
    { name: "hat", icon: "🎩" },
    { name: "ball", icon: "⚽" },
  ].map(Object.freeze),
);

export const CODE_LENGTH = 3;

const byName = new Map(SYMBOLS.map((s) => [s.name, s]));
const byIcon = new Map(SYMBOLS.map((s) => [s.icon, s]));
const byPrefix = new Map(SYMBOLS.map((s) => [s.name.slice(0, 2), s]));

/* A fresh code. Math.random is right here: a room code is not simulation
 * state and nothing replays it (hub CLAUDE.md §10 — seed only what must
 * regenerate identically). */
export function newCode() {
  const pick = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].name;
  return Array.from({ length: CODE_LENGTH }, pick).join("-");
}

/*
 * Accept what a human would plausibly write down. Dashes, spaces, commas and
 * the pictures themselves all separate; case is ignored; a name is matched on
 * its first two letters, so "roket", "rockets" and "rocket" are one symbol.
 * Returns the canonical dashed code, or "" if it is not a code — which the
 * caller must say out loud rather than sending a wrong id to the broker and
 * reporting "no game found" for what was really a typo.
 */
export function parseCode(text) {
  const raw = String(text ?? "").toLowerCase();
  const parts = [];
  // Pull the emoji out first: they are not letters, so the word split below
  // would drop them, and a pasted code is very often three pictures.
  for (const ch of raw) {
    const symbol = byIcon.get(ch);
    if (symbol) parts.push(symbol.name);
  }
  if (parts.length !== CODE_LENGTH) {
    parts.length = 0;
    for (const word of raw.split(/[^a-z]+/)) {
      if (!word) continue;
      const symbol = byName.get(word) ?? byPrefix.get(word.slice(0, 2));
      if (!symbol) return "";
      parts.push(symbol.name);
    }
  }
  return parts.length === CODE_LENGTH ? parts.join("-") : "";
}

/* The pictures for a code, for showing it back. Empty array if it is junk. */
export function codeIcons(code) {
  const parsed = parseCode(code);
  if (!parsed) return [];
  return parsed.split("-").map((name) => byName.get(name).icon);
}
