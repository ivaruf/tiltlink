/*
 * webrtc.js — the connection, and the two lanes on it.
 *
 * Lifted from neonfox/js/net/webrtc.js and trimmed for a demo: no i18n, no
 * self-hosted relay tier. Everything above this file talks to "channels":
 * anything with send(value, fast), onMessage and onClose, so main.js never
 * touches WebRTC directly and the same code runs over BroadcastChannel
 * between two tabs.
 *
 * TWO LANES (hub CLAUDE.md §8):
 *
 *   "game"  ordered, reliable. Hello, colour, bumps, taps.
 *   "fast"  ordered: false, maxRetransmits: 0. Tilt, thirty times a second —
 *           a late tilt is worthless because a newer one is already coming.
 *
 * One addition over neonfox: the wrapped channel carries `connection`, so the
 * host can ask getStats() whether a phone is on a direct path or relayed
 * through TURN. That is half the point of a tech demo for the relay.
 */

/*
 * ICE: STUN finds a direct path most of the time; for the one pair in ten
 * that cannot, Cloudflare TURN relays the traffic itself, for as long as the
 * connection lives. Credentials come from the hub's gopher-cloud-turn Worker
 * (tools/turn/worker.js), fetched only when someone hosts or joins.
 *
 * The trade, as neonfox states it: Cloudflare sees the IP addresses and
 * traffic volume of relayed players, never the data — the relay forwards
 * ciphertext. If the Worker cannot be reached (blocked, slow, or an origin
 * it does not allow, which includes localhost and a LAN IP) we use STUN
 * alone, and the demo says which it got.
 *
 * `?relay` forces every connection through TURN: if a phone connects with
 * it, the relay works.
 */
const STUN = { urls: ["stun:stun.l.google.com:19302"] };
const TURN_URL = "https://gopher-cloud-turn.ivar-fredriksen.workers.dev";
const TURN_FETCH_MS = 3000;
const TURN_REUSE_MS = 45 * 60 * 1000;
const forceRelay = (() => {
  try {
    return new URLSearchParams(location.search).has("relay");
  } catch {
    return false;
  }
})();

let turnCache = null; // { at, servers }

/* Whether the last iceConfig() got TURN, for the status line. */
export let haveTurn = false;

export async function iceConfig() {
  if (!turnCache || Date.now() - turnCache.at > TURN_REUSE_MS) {
    try {
      const response = await fetch(TURN_URL, {
        signal: AbortSignal.timeout(TURN_FETCH_MS),
        cache: "no-store",
      });
      const body = response.ok ? await response.json() : null;
      const servers = Array.isArray(body?.iceServers) ? body.iceServers : null;
      if (servers?.length) turnCache = { at: Date.now(), servers };
    } catch {
      /* STUN alone; tried again on the next host or join. */
    }
  }
  haveTurn = !!turnCache;
  const config = { iceServers: turnCache?.servers ?? [STUN] };
  if (forceRelay) config.iceTransportPolicy = "relay";
  return config;
}

const UNRELIABLE = { ordered: false, maxRetransmits: 0 };

/* Same browser, different tabs. No third party; exercises the whole path. */
export function broadcastSignalling(code) {
  const bus = new BroadcastChannel(`tiltlink-signal-${code}`);
  const listeners = new Set();
  bus.onmessage = (e) => {
    for (const fn of listeners) fn(e.data);
  };
  return {
    post: (message) => bus.postMessage(message),
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close: () => bus.close(),
  };
}

/* Wrap a pair of data channels as one channel with an explicit lane. */
function wrap(reliable, fast, connection) {
  let closed = false;
  const channel = {
    connection,
    get open() {
      return !closed && reliable.readyState === "open";
    },
    send(value, useFast = false) {
      const lane = useFast && fast?.readyState === "open" ? fast : reliable;
      if (lane.readyState !== "open") return false;
      try {
        lane.send(JSON.stringify(value));
      } catch {
        return false;
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        connection.close();
      } catch {
        /* Already gone. */
      }
      channel.onClose?.();
    },
    onMessage: null,
    onClose: null,
  };
  const receive = (e) => {
    if (typeof e.data !== "string") return;
    let value;
    try {
      value = JSON.parse(e.data);
    } catch {
      return;
    }
    channel.onMessage?.(value);
  };
  for (const lane of [reliable, fast]) if (lane) lane.onmessage = receive;
  connection.onconnectionstatechange = () => {
    if (
      ["failed", "closed", "disconnected"].includes(connection.connectionState)
    )
      channel.close();
  };
  return channel;
}

/* Platform objects do not survive BroadcastChannel or JSON; send plain ones. */
const plainDescription = (d) => ({ type: d.type, sdp: d.sdp });
const plainCandidate = (c) =>
  typeof c.toJSON === "function"
    ? c.toJSON()
    : {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      };

const opened = (lane) =>
  new Promise((resolve, reject) => {
    if (lane.readyState === "open") return resolve(lane);
    lane.onopen = () => resolve(lane);
    lane.onerror = reject;
  });

/* Host: answer anyone who offers, and hand each finished channel up. */
export function hostOverWebRTC(signalling, onPeer) {
  const pending = new Map();
  const ice = iceConfig();
  // Candidates can beat the offer's processing; addIceCandidate throws
  // before a remote description exists, so hold them per guest.
  const early = new Map();
  const handler = async (message) => {
    if (message?.from === undefined) return;
    const id = message.from;
    try {
      if (message.type === "OFFER") {
        // A second offer from the same id is a phone that reloaded.
        pending.get(id)?.close();
        pending.delete(id);
        if (!early.has(id)) early.set(id, []);
        const connection = new RTCPeerConnection(await ice);
        pending.set(id, connection);
        const lanes = {};
        connection.ondatachannel = (e) => {
          lanes[e.channel.label] = e.channel;
          if (lanes.game && lanes.fast)
            onPeer(id, wrap(lanes.game, lanes.fast, connection));
        };
        connection.onicecandidate = (e) => {
          if (e.candidate)
            signalling.post({
              type: "ICE",
              to: id,
              from: "host",
              candidate: plainCandidate(e.candidate),
            });
        };
        await connection.setRemoteDescription(message.description);
        for (const candidate of early.get(id) ?? [])
          await connection.addIceCandidate(candidate).catch(() => {});
        early.delete(id);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        signalling.post({
          type: "ANSWER",
          to: id,
          from: "host",
          description: plainDescription(answer),
        });
      } else if (message.type === "ICE" && message.to === "host") {
        if (!message.candidate) return;
        const connection = pending.get(id);
        if (connection?.remoteDescription)
          await connection.addIceCandidate(message.candidate).catch(() => {});
        else if (early.has(id)) early.get(id).push(message.candidate);
        else early.set(id, [message.candidate]);
      }
    } catch {
      /* One phone's bad offer is not the room's problem. */
    }
  };
  signalling.on(handler);
  return {
    close() {
      signalling.off(handler);
      for (const connection of pending.values()) connection.close();
      pending.clear();
      early.clear();
      signalling.close();
    },
  };
}

/* Guest: offer, wait for the answer, resolve once both lanes are open. */
export async function joinOverWebRTC(signalling, { timeout = 15000 } = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  const connection = new RTCPeerConnection(await iceConfig());
  const reliable = connection.createDataChannel("game");
  const fast = connection.createDataChannel("fast", UNRELIABLE);
  connection.onicecandidate = (e) => {
    if (e.candidate)
      signalling.post({
        type: "ICE",
        to: "host",
        from: id,
        candidate: plainCandidate(e.candidate),
      });
  };
  const handler = async (message) => {
    if (message?.to !== id) return;
    try {
      if (message.type === "ANSWER")
        await connection.setRemoteDescription(message.description);
      else if (message.type === "ICE" && message.candidate)
        await connection.addIceCandidate(message.candidate).catch(() => {});
    } catch {
      /* The timeout below is the backstop. */
    }
  };
  signalling.on(handler);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  signalling.post({
    type: "OFFER",
    from: id,
    description: plainDescription(offer),
  });
  try {
    await Promise.race([
      Promise.all([opened(reliable), opened(fast)]),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The screen did not answer.")),
          timeout,
        ),
      ),
    ]);
  } catch (error) {
    signalling.off(handler);
    connection.close();
    throw error;
  }
  signalling.off(handler);
  return wrap(reliable, fast, connection);
}

/*
 * Direct or relayed? The selected candidate pair's local end is a "relay"
 * candidate exactly when TURN is carrying this connection. Resolves to
 * "direct", "relay" or "" if the stats are not there yet.
 */
export async function pathOf(connection) {
  try {
    const stats = await connection.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId)
        pair = stats.get(s.selectedCandidatePairId);
    });
    // Firefox has no transport.selectedCandidatePairId; it marks the pair.
    if (!pair)
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && s.selected) pair = s;
      });
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    if (!local) return "";
    return local.candidateType === "relay" || remote?.candidateType === "relay"
      ? "relay"
      : "direct";
  } catch {
    return "";
  }
}
