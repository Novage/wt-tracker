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

import Debug from "debug";
import {
  Tracker,
  SocketContext,
  PeerContext,
  TrackerError,
} from "./tracker.js";

const debug = Debug("wt-tracker:fast-tracker");
const debugEnabled = debug.enabled;

type UnknownObject = Record<string, unknown>;

interface Settings {
  maxOffers: number;
  announceInterval: number;
}

export class FastTracker implements Tracker {
  public readonly settings: Settings;

  readonly #swarms = new Map<string, Swarm>();
  readonly #peersContext = new Map<string, PeerContext>();

  private clearPeersInterval?: NodeJS.Timeout;

  public constructor(settings?: Partial<Settings>) {
    this.settings = {
      maxOffers: 20,
      announceInterval: 20,
      ...settings,
    };
    this.startClearPeersInterval();
  }

  private startClearPeersInterval(): void {
    if (this.clearPeersInterval === undefined) {
      this.clearPeersInterval = setInterval(() => {
        const now = performance.now();
        for (const peer of this.#peersContext.values()) {
          if (
            now - peer.lastAccessed >
            this.settings.announceInterval * 2 * 1000
          ) {
            this.removePeer(peer);
          }
        }
      }, this.settings.announceInterval * 1000);
    }
  }

  private removeEmptySwarm(swarm: Swarm) {
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

  private removePeer(peerContext: PeerContext) {
    const swarm = this.#swarms.get(peerContext.swarmInfoHash);

    if (swarm === undefined) {
      throw new TrackerError("disconnect peer: swarm is undefined");
    }

    swarm.removePeer(peerContext);

    this.removeEmptySwarm(swarm);

    const peerId = peerContext.peerId;

    if (debugEnabled) {
      debug(
        "disconnect peer: peer",
        Buffer.from(peerId).toString("hex"),
        "removed from swarm",
        Buffer.from(swarm.infoHash).toString("hex"),
      );
    }

    this.#peersContext.delete(peerId);

    delete (peerContext.socketContext as unknown as UnknownObject)[peerId];
  }

  public get swarms(): ReadonlyMap<string, { peers: readonly PeerContext[] }> {
    return this.#swarms;
  }

  public processMessage(jsonObject: object, peer: SocketContext): void {
    const json = jsonObject as UnknownObject;
    const action = json.action;

    if (action === "announce") {
      const event = json.event;
      if (event === undefined) {
        if (json.answer === undefined) {
          this.processAnnounce(json, peer);
        } else {
          this.processAnswer(json);
        }
      } else if (event === "started") {
        this.processAnnounce(json, peer);
      } else if (event === "stopped") {
        this.processStop(json);
      } else if (event === "completed") {
        this.processAnnounce(json, peer, true);
      } else {
        throw new TrackerError("unknown announce event");
      }
    } else if (action === "scrape") {
      this.processScrape(json, peer);
    } else {
      throw new TrackerError("unknown action");
    }
  }

  public disconnectPeersFromSocket(peerSocket: SocketContext): void {
    for (const peerId in peerSocket) {
      const peerContext = (peerSocket as unknown as UnknownObject)[
        peerId
      ] as PeerContext;

      if (peerContext.peerId === undefined) continue;
      this.removePeer(peerContext);
    }
  }

  private processAnnounce(
    json: UnknownObject,
    peer: SocketContext,
    completed = false,
  ): void {
    const infoHash = json.info_hash as string;
    const peerId = json.peer_id as string;
    let swarm: Swarm | undefined;
    const isPeerCompleted = completed || json.left === 0;

    let peerContext = (peer as unknown as UnknownObject)[peerId] as
      | PeerContext
      | undefined;

    if (peerContext === undefined) {
      peerContext = this.#peersContext.get(peerId);

      if (peerContext !== undefined) return;

      peerContext = {
        peerId,
        sendMessage: peer.sendMessage,
        socketContext: peer,
        lastAccessed: performance.now(),
        swarmInfoHash: infoHash,
      };

      swarm = this.addPeerToSwarm(peer, peerContext, infoHash, isPeerCompleted);

      (peer as unknown as UnknownObject)[peerId] = peerContext;
      this.#peersContext.set(peerId, peerContext);
    } else if (peerContext.peerId === peerId) {
      peerContext.lastAccessed = performance.now();

      if (infoHash !== peerContext.swarmInfoHash) {
        const oldSwarm = this.#swarms.get(peerContext.swarmInfoHash);

        if (oldSwarm === undefined) {
          throw new TrackerError("announce: old swarm is undefined");
        }

        oldSwarm.removePeer(peerContext);

        this.removeEmptySwarm(oldSwarm);

        peerContext.swarmInfoHash = infoHash;
        swarm = this.addPeerToSwarm(
          peer,
          peerContext,
          infoHash,
          isPeerCompleted,
        );
      } else {
        swarm = this.#swarms.get(peerContext.swarmInfoHash);

        if (swarm === undefined) {
          throw new TrackerError("announce: swarm is undefined");
        }

        if (isPeerCompleted) swarm.setCompleted(peerContext);
      }
    } else {
      throw new TrackerError("announce: peerId mismatch");
    }

    peer.sendMessage(
      {
        action: "announce",
        interval: this.settings.announceInterval,
        info_hash: infoHash,
        complete: swarm.completedCount,
        incomplete: swarm.peers.length - swarm.completedCount,
      },
      peer,
    );

    this.sendOffersToPeers(json, swarm.peers, peerContext, infoHash);
  }

  private addPeerToSwarm(
    peer: SocketContext,
    peerContext: PeerContext,
    infoHash: unknown,
    completed: boolean,
  ): Swarm {
    let swarm = this.#swarms.get(infoHash as string);

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

      swarm = new Swarm(infoHash);
      this.#swarms.set(infoHash, swarm);
    }

    if (debugEnabled) {
      debug(
        "announce: peer",
        Buffer.from(peerContext.peerId).toString("hex"),
        "added to swarm",
        Buffer.from(infoHash as string).toString("hex"),
      );
    }

    swarm.addPeer(peerContext, completed);
    return swarm;
  }

  private sendOffersToPeers(
    json: UnknownObject,
    peers: readonly PeerContext[],
    peer: PeerContext,
    infoHash: string,
  ): void {
    if (peers.length <= 1) {
      return;
    }

    const offers = json.offers;
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
      const offersIterator = (offers as unknown[]).values();
      for (const toPeer of peers) {
        if (toPeer !== peer) {
          sendOffer(
            offersIterator.next().value,
            peer.peerId,
            toPeer.socketContext,
            infoHash,
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
          sendOffer(offers[i], peer.peerId, toPeer.socketContext, infoHash);
        }

        peerIndex++;
        if (peerIndex === peers.length) {
          peerIndex = 0;
        }
      }
    }

    debug(
      "announce: sent offers",
      countOffersToSend < 0 ? 0 : countOffersToSend,
    );
  }

  private processAnswer(json: UnknownObject): void {
    const toPeerId = json.to_peer_id as string;
    const toPeer = this.#peersContext.get(toPeerId);
    if (toPeer === undefined) {
      throw new TrackerError("answer: to_peer_id is not in the swarm");
    }

    delete json.to_peer_id;
    toPeer.sendMessage(json, toPeer.socketContext);

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

    const peer = this.#peersContext.get(peerId);
    if (peer === undefined) return;

    this.removePeer(peer);
  }

  private processScrape(json: UnknownObject, peer: SocketContext): void {
    const infoHash = json.info_hash;
    const files: {
      [key: string]: {
        complete: number;
        incomplete: number;
        downloaded: number;
      };
    } = {};

    if (infoHash === undefined) {
      for (const swarm of this.#swarms.values()) {
        files[swarm.infoHash] = {
          complete: swarm.completedCount,
          incomplete: swarm.peers.length - swarm.completedCount,
          downloaded: swarm.completedCount,
        };
      }
    } else if (infoHash instanceof Array) {
      for (const singleInfoHash of infoHash as unknown[]) {
        const swarm = this.#swarms.get(singleInfoHash as string);
        if (swarm !== undefined) {
          files[singleInfoHash as string] = {
            complete: swarm.completedCount,
            incomplete: swarm.peers.length - swarm.completedCount,
            downloaded: swarm.completedCount,
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
        files[infoHash as string] = {
          complete: swarm.completedCount,
          incomplete: swarm.peers.length - swarm.completedCount,
          downloaded: swarm.completedCount,
        };
      } else if (typeof infoHash === "string") {
        files[infoHash] = {
          complete: 0,
          incomplete: 0,
          downloaded: 0,
        };
      }
    }

    peer.sendMessage({ action: "scrape", files }, peer);
  }
}

class Swarm {
  public completedCount = 0;
  private completedPeers?: Set<string>;

  readonly #peers: PeerContext[] = [];

  public constructor(public readonly infoHash: string) {}

  public get peers(): readonly PeerContext[] {
    return this.#peers;
  }

  public addPeer(peer: PeerContext, completed: boolean): void {
    this.#peers.push(peer);
    if (completed) {
      if (this.completedPeers === undefined) {
        this.completedPeers = new Set();
      }
      this.completedPeers.add(peer.peerId);
      this.completedCount++;
    }
  }

  public removePeer(peer: PeerContext) {
    const index = this.#peers.indexOf(peer);

    if (this.completedPeers?.delete(peer.peerId) === true) {
      this.completedCount--;
    }

    // Delete peerId from array without calling splice
    const last = this.#peers.pop()!;
    if (index < this.#peers.length) {
      this.#peers[index] = last;
    }
  }

  public setCompleted(peer: PeerContext): void {
    if (this.completedPeers === undefined) {
      this.completedPeers = new Set();
    }

    if (!this.completedPeers.has(peer.peerId)) {
      this.completedPeers.add(peer.peerId);
      this.completedCount++;
    }
  }
}

function sendOffer(
  offerItem: unknown,
  fromPeerId: string,
  toPeer: SocketContext,
  infoHash: string,
): void {
  if (!(offerItem instanceof Object)) {
    throw new TrackerError("announce: wrong offer item format");
  }

  const offer = (offerItem as UnknownObject).offer;
  const offerId = (offerItem as UnknownObject).offer_id;

  if (!(offer instanceof Object)) {
    throw new TrackerError("announce: wrong offer item field format");
  }

  toPeer.sendMessage(
    {
      action: "announce",
      info_hash: infoHash,
      offer_id: offerId, // offerId is not validated to be a string
      peer_id: fromPeerId,
      offer: {
        type: "offer",
        sdp: (offer as UnknownObject).sdp, // offer.sdp is not validated to be a string
      },
    },
    toPeer,
  );
}
