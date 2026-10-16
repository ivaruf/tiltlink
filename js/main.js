/*
 * main.js — decide which half of the demo this device is.
 *
 *   #join=<code>   a phone that scanned the QR → the pad, straight away
 *   (nothing)      ask: big screen, or join with a code
 *
 * The role lives in the hash, not the query, so the stage's own URL with
 * the hash glued on is the whole join link and the dev server never sees it.
 */

import { parseCode } from "./net/codes.js";
import { startStage } from "./stage.js";
import { startPad, startKeypad } from "./pad.js";

const show = (id) => {
  for (const el of document.querySelectorAll("body > section"))
    el.hidden = el.id !== id;
};

const fromHash = () => {
  const match = /join=([^&]+)/.exec(location.hash);
  return match ? parseCode(decodeURIComponent(match[1])) : "";
};

function route() {
  const code = fromHash();
  if (code) {
    show("pad");
    startPad(code);
    return;
  }
  show("home");
}

document.getElementById("go-stage").addEventListener("click", () => {
  show("stage");
  startStage();
});
document.getElementById("go-keypad").addEventListener("click", () => {
  show("keypad");
  startKeypad((code) => {
    // Through the hash, so a reload rejoins the same screen.
    location.hash = `join=${code}`;
  });
});
addEventListener("hashchange", route);

route();
