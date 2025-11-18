/**
 * Copyright 2019 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { threadId } from "node:worker_threads";
import Debug from "debug";
import type { Tracker } from "./tracker.ts";
import { TrackerError } from "./tracker.ts";

const debugSuffix = threadId ? `-${threadId}` : "";
const debug = Debug(`wt-tracker:fast-tracker${debugSuffix}`);
const debugEnabled = debug.enabled;

interface Swarm<ConnectionContext extends Record<string, unknown>> {
  infoHash: string;
  completedPeers?: Set<string>;
  peers: PeerContext<ConnectionContext>[];
}

interface PeerContext<ConnectionContext extends Record<string, unknown>> {
  peerId: string;
  connection: ConnectionContext;
  lastAccessed: number;
  swarm: Swarm<ConnectionContext>;
}

type UnknownObject = Record<string, unknown>;

export type FastTrackerSettings = {
  maxOffers: number;
  announceInterval: number;
};

export class FastTracker<ConnectionContext extends Record<string, unknown>>
  implements Tracker<ConnectionContext>
{
  public readonly settings: FastTrackerSettings;
  #sendMessage: (json: UnknownObject, connection: ConnectionContext) => void;

  readonly #swarms = new Map<string, Swarm<ConnectionContext>>();
  public get swarms() {
    return this.#swarms;
  }

  public getSwarms() {
    const result = [];

    for (const swarm of this.#swarms.values()) {
      result.push({
        infoHash: swarm.infoHash,
        peersCount: swarm.peers.length,
      });
    }

    return Promise.resolve([result]);
  }

  readonly #peers = new Map<string, PeerContext<ConnectionContext>>();
  public get peers() {
    return this.#peers;
  }

  #clearPeersInterval?: NodeJS.Timeout;

  #onRemovePeer?: (peerId: string, connection: ConnectionContext) => void;
  set onRemovePeer(
    callback:
      | ((peerId: string, connection: ConnectionContext) => void)
      | undefined,
  ) {
    this.#onRemovePeer = callback ?? undefined;
  }

  public constructor(
    settings: Partial<FastTrackerSettings> | undefined,
    sendMessage: (json: UnknownObject, connection: ConnectionContext) => void,
  ) {
    this.#sendMessage = sendMessage;
    this.settings = {
      maxOffers: 20,
      announceInterval: 20,
      ...settings,
    };
    this.startClearPeersInterval();
  }

  private getOrCreateSwarm(infoHash: string) {
    let swarm = this.#swarms.get(infoHash);

    if (swarm === undefined) {
      if (typeof infoHash !== "string") {
        throw new TrackerError("announce: info_hash field is missing or wrong");
      }

      if (debugEnabled) {
        debug(
          "announce: swarm created:",
          Buffer.from(infoHash).toString("hex"),
        );
      }

      swarm = {
        infoHash,
        peers: [],
      };

      this.#swarms.set(infoHash, swarm);
    }

    return swarm;
  }

  private addPeerToSwarm(
    swarm: Swarm<ConnectionContext>,
    peer: PeerContext<ConnectionContext>,
    isPeerCompleted: boolean,
  ) {
    swarm.peers.push(peer);
    if (isPeerCompleted) {
      swarm.completedPeers ??= new Set();
      swarm.completedPeers.add(peer.peerId);
    }
  }

  private removePeerFromSwarm(
    swarm: Swarm<ConnectionContext>,
    peer: PeerContext<ConnectionContext>,
  ) {
    const peerIndex = swarm.peers.indexOf(peer);

    swarm.completedPeers?.delete(peer.peerId);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const lastPeer = swarm.peers.pop()!;
    if (peerIndex < swarm.peers.length) {
      swarm.peers[peerIndex] = lastPeer;
    }

    if (swarm.peers.length === 0) {
      if (debugEnabled) {
        debug(
          "disconnect peer: swarm removed (empty)",
          Buffer.from(swarm.infoHash).toString("hex"),
        );
      }
      this.#swarms.delete(swarm.infoHash);
    }
  }

  private setPeerCompletedInSwarm(
    swarm: Swarm<ConnectionContext>,
    peer: PeerContext<ConnectionContext>,
  ) {
    swarm.completedPeers ??= new Set();
    swarm.completedPeers.add(peer.peerId);
  }

  private startClearPeersInterval(): void {
    this.#clearPeersInterval = setInterval(() => {
      const now = performance.now();
      for (const peer of this.#peers.values()) {
        if (
          now - peer.lastAccessed >
          this.settings.announceInterval * 2 * 1000
        ) {
          if (debugEnabled) {
            debug(
              "remove by timeout peer:",
              Buffer.from(peer.peerId).toString("hex"),
              "swarm:",
              Buffer.from(peer.swarm.infoHash).toString("hex"),
            );
          }
          this.removePeer(peer);
        }
      }
    }, this.settings.announceInterval * 1000);
  }

  private removePeer(peer: PeerContext<ConnectionContext>) {
    const { swarm } = peer;

    this.removePeerFromSwarm(swarm, peer);
    this.#peers.delete(peer.peerId);

    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete peer.connection[peer.peerId];

    this.#onRemovePeer?.(peer.peerId, peer.connection);
  }

  public processMessage(
    json: UnknownObject,
    connection: ConnectionContext,
  ): void {
    const { action } = json;

    if (action === "announce") {
      const { event } = json;
      if (event === undefined) {
        if (json.answer === undefined) {
          this.processAnnounce(json, connection);
        } else {
          this.processAnswer(json);
        }
      } else if (event === "started") {
        this.processAnnounce(json, connection);
      } else if (event === "stopped") {
        this.processStop(json);
      } else if (event === "completed") {
        this.processAnnounce(json, connection, true);
      } else {
        throw new TrackerError("unknown announce event");
      }
    } else if (action === "scrape") {
      this.processScrape(json, connection);
    } else {
      throw new TrackerError("unknown action");
    }
  }

  public disconnect(connection: ConnectionContext): void {
    // Connection closed - remove all peers

    for (const peerId in connection) {
      const peer = connection[peerId] as
        | PeerContext<ConnectionContext>
        | undefined;

      if (!peer?.peerId) continue; // Not a peer property

      if (debugEnabled) {
        debug(
          "disconnect peer:",
          Buffer.from(peer.peerId).toString("hex"),
          "swarm:",
          Buffer.from(peer.swarm.infoHash).toString("hex"),
        );
      }

      this.removePeer(peer);
    }
  }

  private processAnnounce(
    json: UnknownObject,
    connection: ConnectionContext,
    completed = false,
  ): void {
    const infoHash = json.info_hash as string;
    const peerId = json.peer_id as string;
    let swarm: Swarm<ConnectionContext> | undefined;
    const isPeerCompleted = completed || json.left === 0;

    let peer = connection[peerId] as PeerContext<ConnectionContext> | undefined;

    if (peer === undefined) {
      const existingPeer = this.#peers.get(peerId);

      if (existingPeer) {
        // The peer previously was on a different connection

        if (debugEnabled) {
          debug(
            "peer changed connection:",
            Buffer.from(existingPeer.peerId).toString("hex"),
          );
        }

        this.removePeer(existingPeer);
      }

      swarm = this.getOrCreateSwarm(infoHash);

      peer = {
        peerId,
        connection,
        lastAccessed: performance.now(),
        swarm,
      };

      this.addPeerToSwarm(swarm, peer, isPeerCompleted);

      (connection as unknown as UnknownObject)[peerId] = peer;
      this.#peers.set(peerId, peer);
    } else if (peer.peerId === peerId) {
      peer.lastAccessed = performance.now();

      if (infoHash !== peer.swarm.infoHash) {
        // Peer changes swarm
        const oldSwarm = peer.swarm;

        this.removePeerFromSwarm(oldSwarm, peer);

        swarm = this.getOrCreateSwarm(infoHash);
        peer.swarm = swarm;
        this.addPeerToSwarm(swarm, peer, isPeerCompleted);
      } else {
        ({ swarm } = peer);
        if (isPeerCompleted) {
          this.setPeerCompletedInSwarm(swarm, peer);
        }
      }
    } else {
      throw new TrackerError("announce: peerId mismatch");
    }

    const complete = swarm.completedPeers?.size ?? 0;

    this.#sendMessage(
      {
        action: "announce",
        interval: this.settings.announceInterval,
        info_hash: infoHash,
        complete,
        incomplete: swarm.peers.length - complete,
      },
      connection,
    );

    this.sendOffersToPeers(json, swarm.peers, peer, infoHash);
  }

  private sendOffersToPeers(
    json: UnknownObject,
    peers: readonly PeerContext<ConnectionContext>[],
    peer: PeerContext<ConnectionContext>,
    infoHash: string,
  ): void {
    if (peers.length <= 1) {
      return;
    }

    const { offers } = json;
    if (offers === undefined) {
      return;
    } else if (!(offers instanceof Array)) {
      throw new TrackerError("announce: offers field is not an array");
    }

    const numwant = json.numwant as number;
    if (!Number.isInteger(numwant)) {
      return;
    }

    const countPeersToSend = peers.length - 1;
    const countOffersToSend = Math.min(
      countPeersToSend,
      offers.length,
      this.settings.maxOffers,
      numwant,
    );

    if (countOffersToSend === countPeersToSend) {
      // we have offers for all the peers from the swarm - send offers to all
      const offersIterator = offers.values();
      for (const toPeer of peers) {
        if (toPeer !== peer) {
          this.#sendMessage(
            getSendOfferJson(
              offersIterator.next().value,
              peer.peerId,
              infoHash,
            ),
            toPeer.connection,
          );
        }
      }
    } else {
      // send offers to random peers
      let peerIndex = Math.floor(Math.random() * peers.length);

      for (let i = 0; i < countOffersToSend; i++) {
        const toPeer = peers[peerIndex];

        if (toPeer === peer) {
          i--; // do one more iteration
        } else {
          this.#sendMessage(
            getSendOfferJson(offers[i], peer.peerId, infoHash),
            toPeer.connection,
          );
        }

        peerIndex++;
        if (peerIndex === peers.length) {
          peerIndex = 0;
        }
      }
    }

    if (debugEnabled) {
      debug(
        "announce: sent offers",
        countOffersToSend < 0 ? 0 : countOffersToSend,
      );
    }
  }

  private processAnswer(json: UnknownObject): void {
    const toPeerId = json.to_peer_id as string;
    const toPeer = this.#peers.get(toPeerId);
    if (toPeer === undefined) {
      throw new TrackerError("answer: to_peer_id is not in the swarm");
    }

    delete json.to_peer_id;
    this.#sendMessage(json, toPeer.connection);

    if (debugEnabled) {
      debug(
        "answer: from peer",
        Buffer.from(json.peer_id as string).toString("hex"),
        "to peer",
        Buffer.from(toPeerId).toString("hex"),
      );
    }
  }

  private processStop(json: UnknownObject): void {
    const peerId = json.peer_id as string;

    const peer = this.#peers.get(peerId);
    if (peer) {
      if (debugEnabled) {
        debug(
          "stop peer:",
          Buffer.from(peer.peerId).toString("hex"),
          "swarm:",
          Buffer.from(peer.swarm.infoHash).toString("hex"),
        );
      }
      this.removePeer(peer);
    }
  }

  private processScrape(
    json: UnknownObject,
    connection: ConnectionContext,
  ): void {
    const infoHash = json.info_hash;
    const files: Record<
      string,
      {
        complete: number;
        incomplete: number;
        downloaded: number;
      }
    > = {};

    if (infoHash === undefined) {
      for (const swarm of this.#swarms.values()) {
        const complete = swarm.completedPeers?.size ?? 0;
        files[swarm.infoHash] = {
          complete,
          incomplete: swarm.peers.length - complete,
          downloaded: complete,
        };
      }
    } else if (infoHash instanceof Array) {
      for (const singleInfoHash of infoHash as unknown[]) {
        const swarm = this.#swarms.get(singleInfoHash as string);
        if (swarm !== undefined) {
          const complete = swarm.completedPeers?.size ?? 0;
          files[singleInfoHash as string] = {
            complete,
            incomplete: swarm.peers.length - complete,
            downloaded: complete,
          };
        } else if (typeof singleInfoHash === "string") {
          files[singleInfoHash] = {
            complete: 0,
            incomplete: 0,
            downloaded: 0,
          };
        }
      }
    } else {
      const swarm = this.#swarms.get(infoHash as string);
      if (swarm !== undefined) {
        const complete = swarm.completedPeers?.size ?? 0;
        files[infoHash as string] = {
          complete,
          incomplete: swarm.peers.length - complete,
          downloaded: complete,
        };
      } else if (typeof infoHash === "string") {
        files[infoHash] = {
          complete: 0,
          incomplete: 0,
          downloaded: 0,
        };
      }
    }

    this.#sendMessage({ action: "scrape", files }, connection);
  }

  public dispose() {
    clearInterval(this.#clearPeersInterval);
  }
}

function getSendOfferJson(
  offerItem: unknown,
  fromPeerId: string,
  infoHash: string,
) {
  if (!(offerItem instanceof Object)) {
    throw new TrackerError("announce: wrong offer item format");
  }

  const { offer } = offerItem as UnknownObject;
  const offerId = (offerItem as UnknownObject).offer_id;

  if (!(offer instanceof Object)) {
    throw new TrackerError("announce: wrong offer item field format");
  }

  return {
    action: "announce",
    info_hash: infoHash,
    offer_id: offerId, // offerId is not validated to be a string
    peer_id: fromPeerId,
    offer: {
      type: "offer",
      sdp: (offer as UnknownObject).sdp, // offer.sdp is not validated to be a string
    },
  };
}
