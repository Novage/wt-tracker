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
  Swarm,
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
  readonly #peers = new Map<string, PeerContext>();

  #clearPeersInterval?: NodeJS.Timeout;

  public constructor(settings?: Partial<Settings>) {
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
    swarm: Swarm,
    peer: PeerContext,
    isPeerCompleted: boolean,
  ) {
    swarm.peers.push(peer);
    if (isPeerCompleted) {
      if (swarm.completedPeers === undefined) {
        swarm.completedPeers = new Set();
      }
      swarm.completedPeers.add(peer.peerId);
    }
  }

  private removePeerFromSwarm(swarm: Swarm, peer: PeerContext) {
    const peerIndex = swarm.peers.indexOf(peer);

    swarm.completedPeers?.delete(peer.peerId);

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

  private setPeerCompletedInSwarm(swarm: Swarm, peer: PeerContext) {
    if (swarm.completedPeers === undefined) {
      swarm.completedPeers = new Set();
    }
    swarm.completedPeers.add(peer.peerId);
  }

  private startClearPeersInterval(): void {
    if (this.#clearPeersInterval !== undefined) {
      clearInterval(this.#clearPeersInterval);
      this.#clearPeersInterval = undefined;
    }

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

  private removePeer(peer: PeerContext) {
    const swarm = peer.swarm;

    this.removePeerFromSwarm(swarm, peer);
    this.#peers.delete(peer.peerId);

    delete (peer.socket as unknown as UnknownObject)[peer.peerId];
  }

  public get swarms(): ReadonlyMap<string, { peers: readonly PeerContext[] }> {
    return this.#swarms;
  }

  public processMessage(jsonObject: object, socket: SocketContext): void {
    const json = jsonObject as UnknownObject;
    const action = json.action;

    if (action === "announce") {
      const event = json.event;
      if (event === undefined) {
        if (json.answer === undefined) {
          this.processAnnounce(json, socket);
        } else {
          this.processAnswer(json);
        }
      } else if (event === "started") {
        this.processAnnounce(json, socket);
      } else if (event === "stopped") {
        this.processStop(json);
      } else if (event === "completed") {
        this.processAnnounce(json, socket, true);
      } else {
        throw new TrackerError("unknown announce event");
      }
    } else if (action === "scrape") {
      this.processScrape(json, socket);
    } else {
      throw new TrackerError("unknown action");
    }
  }

  public disconnectPeersFromSocket(socket: SocketContext): void {
    for (const peerId in socket) {
      const peer = (socket as unknown as UnknownObject)[peerId] as PeerContext;

      if (peer.peerId !== peerId) continue; // Not a peer property
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
    socket: SocketContext,
    completed = false,
  ): void {
    const infoHash = json.info_hash as string;
    const peerId = json.peer_id as string;
    let swarm: Swarm | undefined;
    const isPeerCompleted = completed || json.left === 0;

    let peer = (socket as unknown as UnknownObject)[peerId] as
      | PeerContext
      | undefined;

    if (peer === undefined) {
      const existingPeer = this.#peers.get(peerId);
      if (existingPeer) {
        if (debugEnabled) {
          debug(
            "move peer:",
            Buffer.from(existingPeer.peerId).toString("hex"),
            "from swarm:",
            Buffer.from(existingPeer.swarm.infoHash).toString("hex"),
            "to swarm:",
            Buffer.from(infoHash).toString("hex"),
          );
        }

        this.removePeer(existingPeer);
      }

      swarm = this.getOrCreateSwarm(infoHash);

      peer = {
        peerId,
        sendMessage: socket.sendMessage,
        socket,
        lastAccessed: performance.now(),
        swarm,
      };

      this.addPeerToSwarm(swarm, peer, isPeerCompleted);

      (socket as unknown as UnknownObject)[peerId] = peer;
      this.#peers.set(peerId, peer);
    } else if (peer.peerId === peerId) {
      peer.lastAccessed = performance.now();

      if (infoHash !== peer.swarm.infoHash) {
        const oldSwarm = peer.swarm;

        this.removePeerFromSwarm(oldSwarm, peer);

        swarm = this.getOrCreateSwarm(infoHash);
        peer.swarm = swarm;
        this.addPeerToSwarm(swarm, peer, isPeerCompleted);
      } else {
        swarm = peer.swarm;
        if (isPeerCompleted) {
          this.setPeerCompletedInSwarm(swarm, peer);
        }
      }
    } else {
      throw new TrackerError("announce: peerId mismatch");
    }

    const complete = swarm.completedPeers?.size ?? 0;

    socket.sendMessage(
      {
        action: "announce",
        interval: this.settings.announceInterval,
        info_hash: infoHash,
        complete,
        incomplete: swarm.peers.length - complete,
      },
      socket,
    );

    this.sendOffersToPeers(json, swarm.peers, peer, infoHash);
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
            toPeer.socket,
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
          sendOffer(offers[i], peer.peerId, toPeer.socket, infoHash);
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
    const toPeer = this.#peers.get(toPeerId);
    if (toPeer === undefined) {
      throw new TrackerError("answer: to_peer_id is not in the swarm");
    }

    delete json.to_peer_id;
    toPeer.sendMessage(json, toPeer.socket);

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

  private processScrape(json: UnknownObject, socket: SocketContext): void {
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

    socket.sendMessage({ action: "scrape", files }, socket);
  }
}

function sendOffer(
  offerItem: unknown,
  fromPeerId: string,
  socket: SocketContext,
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

  socket.sendMessage(
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
    socket,
  );
}
