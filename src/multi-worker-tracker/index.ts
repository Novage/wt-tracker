/*
TODO:
- config validate via scheme, reuse scheme types
*/

import os from "node:os";
import { Worker, MessagePort, threadId } from "node:worker_threads";
import Debug from "debug";
import { TrackerError } from "../tracker.ts";
import type { Tracker } from "../tracker.ts";
import type {
  TrackerWorkerInEvent,
  TrackerWorkerOutEvent,
  WorkerDataType,
} from "./types.ts";

const debugSuffix = threadId ? `-${threadId}` : "";
const debug = Debug(`wt-tracker:multi-worker-tracker${debugSuffix}`);

type PeerPortWithConnection<ConnectionContext> = MessagePort & {
  peerId: string;
  connection: ConnectionContext;
  workerIndex: number;
};

export class MultiWorkerTracker<
  ConnectionContext extends Record<string, unknown>,
> implements Tracker<ConnectionContext>
{
  #onRemovePeer?: (peerId: string, connection: ConnectionContext) => void;
  set onRemovePeer(
    callback:
      | ((peerId: string, connection: ConnectionContext) => void)
      | undefined,
  ) {
    this.#onRemovePeer = callback ?? undefined;
  }

  #workerPorts: MessagePort[];
  #sendMessage: (
    json: Record<string, unknown>,
    connection: ConnectionContext,
  ) => void;

  constructor(
    workerPorts: MessagePort[],
    sendMessage: (
      json: Record<string, unknown>,
      connection: ConnectionContext,
    ) => void,
  ) {
    this.#workerPorts = workerPorts;
    this.#sendMessage = sendMessage;
  }

  async getSwarms() {
    const swarms = [];

    for (const workerPort of this.#workerPorts) {
      const stats = await new Promise<TrackerWorkerOutEvent>((resolve) => {
        const requestId = Math.random();

        const listener = (event: Event) => {
          const data = (event as MessageEvent).data as TrackerWorkerOutEvent;

          if (
            // data.type == "stats" &&
            data.id === requestId
          ) {
            resolve(data);
            workerPort.removeEventListener("message", listener);
          }
        };

        workerPort.addEventListener("message", listener);

        workerPort.postMessage({
          type: "getStats",
          id: requestId,
        } satisfies TrackerWorkerInEvent);
      });

      swarms.push(stats.swarms);
    }

    return swarms;
  }

  processMessage(json: Record<string, unknown>, connection: ConnectionContext) {
    // TODO: handle scrape requests by info_hash: undefined, string, array

    const infoHash = json.info_hash;
    if (typeof infoHash !== "string" || infoHash.length < 4) {
      throw new TrackerError("info_hash field is missing or wrong");
    }

    const peerId = json.peer_id;
    if (typeof peerId !== "string" || !peerId) {
      throw new TrackerError("peer_id field is missing or wrong");
    }

    const workerIndex =
      (infoHash.charCodeAt(0) +
        infoHash.charCodeAt(1) +
        infoHash.charCodeAt(2) +
        infoHash.charCodeAt(3)) %
      this.#workerPorts.length;

    const workerPort = this.#workerPorts[workerIndex];

    let peer = connection[peerId] as
      | PeerPortWithConnection<ConnectionContext>
      | undefined;

    if (!peer || peer.workerIndex !== workerIndex) {
      // Create or recreate peer on worker

      const { port1, port2 } = new MessageChannel();

      const peerPort = port1 as PeerPortWithConnection<ConnectionContext>;
      peerPort.connection = connection;
      peerPort.peerId = peerId;
      peerPort.workerIndex = workerIndex;

      peerPort.addEventListener("message", this.processPeerPortMessage);
      peerPort.addEventListener("close", this.processPeerPortClose);

      (connection as Record<string, unknown>)[peerId] = peerPort;

      // Send new peer port to worker
      workerPort.postMessage(
        { type: "newPeer", port: port2 } satisfies TrackerWorkerInEvent,
        [port2],
      );

      // Close existing peer if it is assigned to another worker
      if (peer) peer.close();

      peer = peerPort;
    }

    // debug(
    //   "peer message in",
    //   peer.peerId,
    //   json.info_hash,
    //   json.action,
    //   json.event,
    // );

    // Send message to peer on worker
    peer.postMessage(json);
  }

  processPeerPortMessage = (event: Event) => {
    const messageEvent = event as MessageEvent;
    const peerPort =
      messageEvent.target as PeerPortWithConnection<ConnectionContext>;
    const json = messageEvent.data as Record<string, unknown>;

    // debug(
    //   "peer message out",
    //   peerPort.peerId,
    //   json.info_hash,
    //   json.action,
    //   json.event,
    // );

    this.#sendMessage(json, peerPort.connection);
  };

  processPeerPortClose = (event: Event) => {
    const messageEvent = event as MessageEvent;
    const peerPort =
      messageEvent.target as PeerPortWithConnection<ConnectionContext>;

    const isPeerRecreated = peerPort.connection[peerPort.peerId] !== peerPort;

    debug("peer close", peerPort.peerId, isPeerRecreated);

    if (isPeerRecreated) return;

    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete peerPort.connection[peerPort.peerId];
    this.#onRemovePeer?.(peerPort.peerId, peerPort.connection);
  };

  disconnect(connection: ConnectionContext) {
    debug("disconnect");
    for (const peerId in connection) {
      const peer = connection[peerId] as
        | PeerPortWithConnection<ConnectionContext>
        | undefined;
      if (!peer?.peerId) continue; // Not a peer property

      // Sends `close` message to ports on both sides
      peer.close();
    }
  }

  dispose() {
    // do nothing
  }

  public static buildWorkers(
    // TODO: implement settings: at least configurable worker count
    settings: Record<string, unknown> = {},
  ) {
    const workersCount = os.cpus().length;
    debug("starting", workersCount, "workers");

    const workers: Worker[] = [];
    const moduleExtension = import.meta.filename.endsWith(".js") ? "js" : "ts";

    for (let workerIndex = 0; workerIndex < workersCount; workerIndex++) {
      workers.push(
        new Worker(`${import.meta.dirname}/worker.${moduleExtension}`, {
          workerData: { settings } satisfies WorkerDataType,
        }),
      );
    }

    return {
      buildWorkerPorts: () => {
        const ports = [];

        for (const worker of workers) {
          const { port1, port2 } = new MessageChannel();
          worker.postMessage(
            { type: "port", port: port2 } satisfies TrackerWorkerInEvent,
            [port2],
          );
          ports.push(port1);
        }

        return ports;
      },

      terminateWorkers: () =>
        Promise.allSettled(workers.map((worker) => worker.terminate())),
    };
  }
}
