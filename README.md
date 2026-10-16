# TiltLink

A tech demo: a phone's tilt rolls a ball on a big screen, over WebRTC, joined
by scanning a QR code. It's the seed of a phones-as-controllers party game,
not a game yet.

## How it works

- **The big screen** ("This is the big screen") takes a three-picture room
  code, holds it at the PeerJS broker, and shows it as a QR code, as the
  three pictures with their names, and as a link. Each phone that joins gets
  a ball in its own colour (up to eight).
- **The phone** opens the QR's link (`#join=pizza-pizza-moon`), taps
  **Connect**, and holds the phone like a tray. **Level** sets the current
  angle as flat. **Pulse** sends a tap that the screen shows as a ring and a
  hop. A phone that didn't scan can tap the code in on the picture keypad.
- **On the wire:** the phone sends `{t:"tilt", x, y}` (−1…1) 30 times a
  second on the unreliable lane. The screen owns the physics (host-
  authoritative, hub §8) and sends back `hello` (your colour), `bump` (the
  phone buzzes on Android and the tray flashes on all phones) and `path`.
- **Direct or relayed:** the screen asks `getStats()` every two seconds
  whether each phone is on a direct path or relayed through Cloudflare TURN,
  and shows it in the roster ("direct" / "via TURN") and on the phone.
  Add `?relay` to the screen's URL to force the relay for every phone.

The network files in `js/net/` are neonfox's, trimmed (no i18n, no self-run
relay tier). `vendor/peerjs.js` is the same pinned copy neonfox ships, and
`vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhiko/qrcode-generator)
1.4.4 by Kazuhiko Arase (MIT), vendored so drawing the QR asks nobody
anything.

## Running it, and the two catches

Serve the hub root (`python3 -m http.server 7777`) and open `/tiltlink/`.

1. **The QR carries the screen's own address.** If the screen is on
   `localhost`, the phone gets a link to its own localhost, which goes
   nowhere. Open the screen via the Mac's LAN IP (`http://192.168.x.x:7777/tiltlink/`)
   and the QR will point there instead. The screen warns about this.
2. **Phones only expose tilt over HTTPS.** Over the LAN IP the phone falls
   back to a **drag pad** (drag in the box; it springs back when you let
   go). That still tests WebRTC, the QR, the colours and the bumps. Real
   tilt needs the Pages URL. A LAN origin also gets no TURN (the Worker only
   answers the Pages origins), so it connects on STUN alone, which is fine on
   one wifi.

Two tabs in one desktop browser also work, through the broker or, if it
can't be loaded, through `BroadcastChannel`.

## What it deliberately skips

It's a demo, so there's no service worker, manifest, icons, i18n, corner
plates, Escape handling or way back to the arcade. Those are the hub's floor
for an arcade game and arrive if this becomes one.

## Known limits

- No host migration: close the screen's tab and every phone drops.
- Sideways phones are mapped through `screen.orientation.angle`, but holding
  the phone upright (beta near 90°) makes `gamma` unstable. Hold it like a
  tray.
