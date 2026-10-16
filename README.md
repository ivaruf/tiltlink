# TiltLink

A minigame and tech demo: every phone is a blob on the big screen, tilted
to roll, and **Pulse** is the attack. Pulse right next to someone and they
lose a life; ten lives each, last blob standing wins. Phones join by
scanning a QR code, over WebRTC. Not in the arcade, on purpose.

## How it plays

- **Lobby.** The big screen ("This is the big screen") shows the QR code
  and the three-picture code. Phones join and roll about. Pulses push but
  don't hurt, so everyone gets a feel for the reach. The host picks
  **0–8 bots** and presses **Start**.
- **Round.** Everyone starts on ten lives, spread round a circle. A pulse is
  a shockwave about one blob-width wide, and the ring on screen grows to
  exactly its reach. Every blob inside it is knocked away and loses a life.
  0.8 s cooldown, enforced by the screen. At zero the blob pops and that
  phone watches. A phone that joins mid-round waits for the next.
- **Over.** "Pink wins!" (or a bot does), then **Rematch** or **Lobby**,
  with the same phones still connected.
- **Bots** have the same physics, pulse and cooldown as a phone. They wobble
  as they steer and are a little slow on the trigger, so they can be beaten.

## Your attack sound

On the phone, **Your sound** opens the recorder (it needs HTTPS and asks
for the mic). Hold the button and shout. The phone keeps 0.4 s, starting
just before the loud part, levels it, previews it, and sends it to the
screen. It plays every time you pulse, with a little pitch scatter. Players
without a clip get a synth whomp.

- **The phone decodes, not the TV.** It sends raw 16 kHz mono PCM (12.8 KB,
  three base64 chunks on the reliable lane), so the TV never has to decode
  a phone codec it may not know.
- **The mic is open only while the sound panel is.** Done closes it.
- **The clip never leaves the room's devices.** It goes phone → screen over
  the encrypted channel and is gone when the screen's tab closes.
- **The screen has a limiter**, and each player's row has a **sound on/off**
  button, since their voice is playing through your TV.

## Under the hood

| file | does |
| --- | --- |
| `js/main.js` | picks the role: `#join=<code>` is a phone, otherwise ask |
| `js/stage.js` | the big screen: room, QR, lobby and result panels, roster, wire |
| `js/arena.js` | physics, pulses, lives, phases, bots, drawing |
| `js/sound.js` | the screen's audio: clips, whomp/hit/pop, limiter |
| `js/pad.js` | the phone: tilt or drag, pulse, lives, keypad |
| `js/recorder.js` | mic capture, trim, level, resample, chunk |
| `js/net/` | neonfox's WebRTC + PeerJS rendezvous + picture codes, trimmed |

- **On the wire:** the phone sends `tilt` (−1…1, 30 Hz, unreliable lane),
  `tap` and `clip` chunks. The screen validates everything and owns the
  fight (host-authoritative, hub §8). It sends back `hello` (your colour and
  name), `phase`, `you` (lives), `pulsed` (start the cooldown bar), `hit`,
  `bump`, `path` and `clip-ok`.
- **Direct or relayed:** each phone's roster row says "direct" or "via
  TURN". Add `?relay` to the screen's URL to force the relay.
- **Sounds:** synthesised at runtime rather than composed in Sonic Pi
  (hub §9), because the clips only exist at runtime and the stock sounds
  are placeholders. `vendor/qrcode.js` is qrcode-generator 1.4.4
  (Kazuhiko Arase, MIT).

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
   one wifi. Recording needs HTTPS too.

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
