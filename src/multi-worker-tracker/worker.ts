import {
  isMainThread,
  workerData,
  MessagePort,
  threadId,
  parentPort,
} from "node:worker_threads";
import Debug from "debug";
import { FastTracker } from "../fast-tracker.js";
import {
  TrackerWorkerInEvent,
  TrackerWorkerOutEvent,
  WorkerDataType,
} from "./types.js";
import { TrackerError } from "../tracker.js";

type WorkerTrackerConnectionContext = MessagePort &
  Record<string, unknown> & {
    peerId: string;
  };

if (!isMainThread && parentPort) {
  // Worker thread

  const { settings } = workerData as WorkerDataType;

  const debug = Debug(`wt-tracker:tracker-worker-${threadId}`);

  debug("worker started");

  const tracker = new FastTracker(settings, sendMessage);
  tracker.onRemovePeer = removePeer;

  parentPort.addEventListener("message", (event: Event) => {
    const messageEvent = event as MessageEvent;
    const data = messageEvent.data as TrackerWorkerInEvent | undefined;

    if (data?.type === "port") {
      // Port from MultiWorkerTracker
      const trackerPort = messageEvent.ports[0] as unknown as MessagePort;
      trackerPort.addEventListener("message", processPortMessage);
    }
  });

  function processPortMessage(event: Event) {
    const messageEvent = event as MessageEvent;
    const data = messageEvent.data as TrackerWorkerInEvent | undefined;

    if (data?.type === "newPeer") {
      debug("new peer");
      // New peer port from MultiWorkerTracker
      const peerPort = data.port;
      peerPort.addEventListener("message", processPeerPortMessage);
      peerPort.addEventListener("close", processPeerPortClose);
    } else if (data?.type === "getStats") {
      const swarms = [];

      for (const swarm of tracker.swarms.values()) {
        swarms.push({
          infoHash: swarm.infoHash,
          peersCount: swarm.peers.length,
        });
      }

      (messageEvent.target as MessagePort).postMessage({
        type: "stats",
        id: data.id,
        threadId,
        swarms,
      } satisfies TrackerWorkerOutEvent);
    }
  }

  function processPeerPortMessage(event: Event) {
    const messageEvent = event as MessageEvent;
    const peerPort = messageEvent.target as WorkerTrackerConnectionContext;
    const json = messageEvent.data as Record<string, unknown>;

    peerPort.peerId = json.peer_id as string;

    try {
      tracker.processMessage(json, peerPort);
    } catch (e) {
      if (e instanceof TrackerError) {
        debug("failed to process message from the peer:", e);
        removePeer(peerPort.peerId, peerPort);
      } else {
        throw e;
      }
    }
  }

  function processPeerPortClose(event: Event) {
    const messageEvent = event as MessageEvent;
    const peerPort = messageEvent.target as WorkerTrackerConnectionContext;

    debug("peer close", peerPort.peerId, tracker.peers.size);
    tracker.disconnect(peerPort);
  }

  function sendMessage(
    json: Record<string, unknown>,
    peerPort: WorkerTrackerConnectionContext,
  ) {
    // debug("peer message out", peerPort.peerId, json.info_hash, json.action);
    peerPort.postMessage(json);
  }

  function removePeer(
    peerId: string,
    peerPort: WorkerTrackerConnectionContext,
  ) {
    debug("peer remove", peerId, peerPort.peerId);
    peerPort.close();
  }
}
