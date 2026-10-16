/*
 * touch-guard.js — stop the browser treating the game as a page of text.
 *
 * On a tablet, a thumb resting on the HUD is a long press, and a drag that
 * starts on a label is a text selection, so Safari highlights words and
 * offers Copy / Look Up in the middle of an aim. css/style.css turns
 * selection and the callout off; this is the half CSS cannot promise, for
 * the engines and the edges where it is not honoured:
 *
 *   selectstart   cancelled unless it begins in a real text field
 *   contextmenu   cancelled likewise — on touch it IS the long-press menu
 *   selectionchange  anything that slipped through anyway is cleared, unless
 *                 a field has focus (a player typing their name must still
 *                 be able to select what they typed)
 *
 * The cost, written down: no right-click menu over the game on desktop
 * either. Nothing in a game wants one, and devtools stay a keystroke away.
 *
 * A classic script, self-contained, importing nothing, for the same reason
 * screen.js is: a failure anywhere in the module graph must not take this
 * down with it, and this must not take anything else down.
 */
(function () {
  'use strict';

  function editable(node) {
    return !!(node && node.closest && node.closest('input, textarea, select, [contenteditable="true"]'));
  }

  document.addEventListener('selectstart', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('contextmenu', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('selectionchange', function () {
    if (editable(document.activeElement)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
  });
})();
