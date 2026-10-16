/*
 * rendezvous.js — how the screen and the phones find each other.
 *
 * Trimmed from neonfox/js/net/rendezvous.js; read that file's header for the
 * full argument. The short version:
 *
 *   broker   PeerJS's public broker, used only as a pipe for OFFER/ANSWER/ICE.
 *            Nothing of ours runs anywhere. Every tier then negotiates the
 *            same two-lane RTCPeerConnection from webrtc.js.
 *   tabs     BroadcastChannel, when the broker cannot be loaded — reaches
 *            other tabs in this browser only, which is still a usable test.
 *
 * The trade, stated plainly: the broker is a third party with no promises.
 * It sees room codes and connection metadata, never anything sent once the
 * phones are connected. Against that, it needs nothing running.
 */

import {
  broadcastSignalling,
  hostOverWebRTC,
  joinOverWebRTC,
  iceConfig,
} from "./webrtc.js";

/* Pinned with SRI, byte-identical local copy behind it (hub §1) — the same
 * file neonfox ships. Loaded only on the first host or join. */
const PEERJS = {
  url: "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js",
  integrity:
    "sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu",
  local: "vendor/peerjs.js",
};

/* The broker's id space is the whole world's; namespace ours. */
const brokerId = (code) => `tiltlink-v1-${code}`;

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = "anonymous";
    }
    // Handled here, so the crash bar in index.html leaves it alone.
    script.dataset.handled = "peerjs";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(script);
  });
}

let loading = null;
function loadBroker() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (loading) return loading;
  loading = (async () => {
    try {
      await loadScript(PEERJS.url, PEERJS.integrity);
    } catch {
      await loadScript(PEERJS.local, null).catch(() => {
        throw new Error("Could not load the matchmaker.");
      });
    }
    if (!window.Peer) throw new Error("The matchmaker loaded but is broken.");
    return window.Peer;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

/* Host side: one PeerJS connection per phone, routed by the `to` field. */
function brokerHostSignalling(peer) {
  const listeners = new Set();
  const pipes = new Set();
  const routes = new Map();
  peer.on("connection", (connection) => {
    pipes.add(connection);
    connection.on("data", (data) => {
      if (!data || typeof data !== "object") return;
      if (typeof data.from === "string") routes.set(data.from, connection);
      for (const fn of listeners) fn(data);
    });
    connection.on("close", () => pipes.delete(connection));
    connection.on("error", () => pipes.delete(connection));
  });
  return {
    post(message) {
      const target = message?.to ? routes.get(message.to) : null;
      const send = (c) => {
        try {
          c.send(message);
        } catch {
          /* A dead pipe takes its phone with it. */
        }
      };
      if (target) send(target);
      else for (const c of pipes) send(c);
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close() {
      listeners.clear();
      for (const c of pipes) {
        try {
          c.close();
        } catch {
          /* Already gone. */
        }
      }
      pipes.clear();
    },
  };
}

function brokerGuestSignalling(connection) {
  const listeners = new Set();
  connection.on("data", (data) => {
    if (data && typeof data === "object") for (const fn of listeners) fn(data);
  });
  return {
    post(message) {
      try {
        connection.send(message);
      } catch {
        /* joinOverWebRTC's timeout is the backstop. */
      }
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close() {
      listeners.clear();
      try {
        connection.close();
      } catch {
        /* Already gone. */
      }
    },
  };
}

const waitFor = (peer, ms, onError) =>
  new Promise((resolve, reject) => {
    peer.on("open", resolve);
    peer.on("error", (error) => reject(onError(error)));
    setTimeout(() => reject(new Error("The matchmaker timed out.")), ms);
  });

/* Hold `code` and hand every phone that joins to onPeer(id, channel). */
export async function hostRendezvous(code, onPeer) {
  try {
    const Peer = await loadBroker();
    const peer = new Peer(brokerId(code), { config: await iceConfig() });
    await waitFor(peer, 20000, (error) =>
      error.type === "unavailable-id"
        ? Object.assign(new Error("That code is taken."), { taken: true })
        : new Error(`Matchmaking failed (${error.type}).`),
    );
    const rtc = hostOverWebRTC(brokerHostSignalling(peer), onPeer);
    /* The broker drops a host whose heartbeat stops — a TV that slept for a
     * minute — and releases the code with it, silently. Reclaim it whenever
     * it is gone (neonfox's reasoning; fishtank measured it). */
    const revive = () => {
      if (peer.destroyed || !peer.disconnected) return;
      try {
        peer.reconnect();
      } catch {
        /* The next beat tries again. */
      }
    };
    peer.on("disconnected", revive);
    const beat = setInterval(revive, 5000);
    document.addEventListener("visibilitychange", revive);
    return {
      mode: "broker",
      close() {
        clearInterval(beat);
        document.removeEventListener("visibilitychange", revive);
        rtc.close();
        peer.destroy();
      },
    };
  } catch (error) {
    if (error.taken) throw error;
    const rtc = hostOverWebRTC(broadcastSignalling(code), onPeer);
    return { mode: "tabs", detail: error.message, close: rtc.close };
  }
}

/* Join the screen behind `code`. Resolves with a channel or throws a message
 * worth showing to a person. */
export async function joinRendezvous(code) {
  let Peer;
  try {
    Peer = await loadBroker();
  } catch {
    const signalling = broadcastSignalling(code);
    const channel = await joinOverWebRTC(signalling);
    return { mode: "tabs", channel };
  }
  const peer = new Peer({ config: await iceConfig() });
  await waitFor(
    peer,
    20000,
    (error) => new Error(`Matchmaking failed (${error.type}).`),
  );
  const pipe = peer.connect(brokerId(code), { reliable: true });
  await new Promise((resolve, reject) => {
    pipe.on("open", resolve);
    peer.on("error", (error) =>
      reject(
        new Error(
          error.type === "peer-unavailable"
            ? "No screen is showing that code."
            : `Could not reach the screen (${error.type}).`,
        ),
      ),
    );
    setTimeout(() => reject(new Error("The screen did not answer.")), 20000);
  });
  try {
    const channel = await joinOverWebRTC(brokerGuestSignalling(pipe));
    // The broker pipe has done its job; the game runs on our own connection.
    return { mode: "broker", channel, close: () => peer.destroy() };
  } catch (error) {
    peer.destroy();
    throw error;
  }
}
