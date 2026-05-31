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

interface Swarm<ConnectionContext> {
  infoHash: string;
  completedCount: number;
  peers: PeerContext<ConnectionContext>[];
}

interface SwarmOnPeer<ConnectionContext> {
  swarm: Swarm<ConnectionContext>;
  swarmTime: number;
  swarmIndex: number; // index of peer in swarm.peers for O(1) removals
  isCompleted: boolean;
  nextSwarmOnPeer?: SwarmOnPeer<ConnectionContext>;
}

interface PeerContext<ConnectionContext>
  extends SwarmOnPeer<ConnectionContext> {
  peerId: string;
  connection: ConnectionContext;
  lastAccessed: number;
  nextPeerOnConn?: PeerContext<ConnectionContext>;
}

type UnknownObject = Record<string, unknown>;

export type FastTrackerSettings = {
  maxOffers: number;
  announceInterval: number;
};

const MAX_POOL_SIZE = 100_000;

// Pools are intentionally module-global: in worker-thread deployment (one tracker
// per thread) this allows objects from a destroyed tracker to be reused by the next.
// dispose() drains them if you need to reclaim memory.
const peerContextPool: PeerContext<unknown>[] = [];
const swarmNodePool: SwarmOnPeer<unknown>[] = [];

const reusableAnnounceMessage = {
  action: "announce" as const,
  interval: 0,
  info_hash: "",
  complete: 0,
  incomplete: 0,
};

const reusableOfferMessage = {
  action: "announce" as const,
  info_hash: "",
  offer_id: undefined as unknown,
  peer_id: "",
  offer: {
    type: "offer" as const,
    sdp: undefined as unknown,
  },
};

function acquireSwarmNode<ConnectionContext>(
  swarm: Swarm<ConnectionContext>,
  time: number,
  index: number,
  isCompleted: boolean,
  next?: SwarmOnPeer<ConnectionContext>,
): SwarmOnPeer<ConnectionContext> {
  const node = swarmNodePool.pop() as SwarmOnPeer<ConnectionContext> | undefined;
  if (node !== undefined) {
    node.swarm = swarm;
    node.swarmTime = time;
    node.swarmIndex = index;
    node.isCompleted = isCompleted;
    node.nextSwarmOnPeer = next;
    return node;
  }
  return {
    swarm,
    swarmTime: time,
    swarmIndex: index,
    isCompleted,
    nextSwarmOnPeer: next,
  };
}

function releaseSwarmNode<ConnectionContext>(
  node: SwarmOnPeer<ConnectionContext>,
): void {
  if (swarmNodePool.length < MAX_POOL_SIZE * 2) {
    node.swarm = undefined as unknown as Swarm<ConnectionContext>;
    node.nextSwarmOnPeer = undefined;
    swarmNodePool.push(node as unknown as SwarmOnPeer<unknown>);
  }
}

function acquirePeerContext<ConnectionContext>(
  peerId: string,
  connection: ConnectionContext,
  lastAccessed: number,
  swarm: Swarm<ConnectionContext>,
  swarmTime: number,
  swarmIndex: number,
  isCompleted: boolean,
): PeerContext<ConnectionContext> {
  const peer = peerContextPool.pop() as PeerContext<ConnectionContext> | undefined;
  if (peer !== undefined) {
    peer.peerId = peerId;
    peer.connection = connection;
    peer.lastAccessed = lastAccessed;
    peer.swarm = swarm;
    peer.swarmTime = swarmTime;
    peer.swarmIndex = swarmIndex;
    peer.isCompleted = isCompleted;
    peer.nextSwarmOnPeer = undefined;
    peer.nextPeerOnConn = undefined;
    return peer;
  }
  return {
    peerId,
    connection,
    lastAccessed,
    swarm,
    swarmTime,
    swarmIndex,
    isCompleted,
    nextSwarmOnPeer: undefined,
    nextPeerOnConn: undefined,
  };
}

function releasePeerContext<ConnectionContext>(
  peer: PeerContext<ConnectionContext>,
): void {
  if (peerContextPool.length < MAX_POOL_SIZE) {
    peer.peerId = "";
    peer.connection = undefined as unknown as ConnectionContext;
    peer.swarm = undefined as unknown as Swarm<ConnectionContext>;
    peer.nextSwarmOnPeer = undefined;
    peer.nextPeerOnConn = undefined;
    peerContextPool.push(peer as unknown as PeerContext<unknown>);
  }
}

function findSwarmOnPeer<ConnectionContext extends Record<string, unknown>>(
  peer: PeerContext<ConnectionContext>,
  swarm: Swarm<ConnectionContext>,
): SwarmOnPeer<ConnectionContext> | undefined {
  let curr: SwarmOnPeer<ConnectionContext> | undefined = peer;
  while (curr !== undefined) {
    if (curr.swarm === swarm) {
      return curr;
    }
    curr = curr.nextSwarmOnPeer;
  }
  return undefined;
}

function addSwarmToPeer<ConnectionContext extends Record<string, unknown>>(
  peer: PeerContext<ConnectionContext>,
  swarm: Swarm<ConnectionContext>,
  time: number,
  index: number,
  isCompleted: boolean,
): void {
  const newNode = acquireSwarmNode(
    swarm,
    time,
    index,
    isCompleted,
    peer.nextSwarmOnPeer,
  );
  peer.nextSwarmOnPeer = newNode;
}

// NOTE: Head-replacement logic (copying swarm/swarmTime/swarmIndex/isCompleted/nextSwarmOnPeer)
// is duplicated in startClearPeersInterval for in-place traversal mutation.
// If SwarmOnPeer fields change, update both locations.
function removeSwarmFromPeer<ConnectionContext extends Record<string, unknown>>(
  peer: PeerContext<ConnectionContext>,
  swarm: Swarm<ConnectionContext>,
): void {
  if (peer.swarm === swarm) {
    const next = peer.nextSwarmOnPeer;
    if (next !== undefined) {
      peer.swarm = next.swarm;
      peer.swarmTime = next.swarmTime;
      peer.swarmIndex = next.swarmIndex;
      peer.isCompleted = next.isCompleted;
      peer.nextSwarmOnPeer = next.nextSwarmOnPeer;
      releaseSwarmNode(next);
    } else {
      peer.swarmIndex = -1;
    }
    return;
  }

  let prev: SwarmOnPeer<ConnectionContext> = peer;
  let curr = peer.nextSwarmOnPeer;
  while (curr !== undefined) {
    if (curr.swarm === swarm) {
      prev.nextSwarmOnPeer = curr.nextSwarmOnPeer;
      releaseSwarmNode(curr);
      return;
    }
    prev = curr;
    curr = curr.nextSwarmOnPeer;
  }
}

function addPeerToConnection<ConnectionContext extends Record<string, unknown>>(
  connectionPeers: Map<ConnectionContext, PeerContext<ConnectionContext>>,
  connection: ConnectionContext,
  peer: PeerContext<ConnectionContext>,
): void {
  const head = connectionPeers.get(connection);
  if (head !== undefined) {
    peer.nextPeerOnConn = head;
  }
  connectionPeers.set(connection, peer);
}

function removePeerFromConnection<
  ConnectionContext extends Record<string, unknown>,
>(
  connectionPeers: Map<ConnectionContext, PeerContext<ConnectionContext>>,
  peer: PeerContext<ConnectionContext>,
): void {
  const head = connectionPeers.get(peer.connection);
  if (head !== undefined) {
    if (head === peer) {
      if (peer.nextPeerOnConn !== undefined) {
        connectionPeers.set(peer.connection, peer.nextPeerOnConn);
      } else {
        connectionPeers.delete(peer.connection);
      }
      peer.nextPeerOnConn = undefined; // break reference chain for GC
    } else {
      let prev = head;
      let curr = head.nextPeerOnConn;
      while (curr !== undefined) {
        if (curr === peer) {
          prev.nextPeerOnConn = curr.nextPeerOnConn;
          curr.nextPeerOnConn = undefined; // break reference chain for GC
          break;
        }
        prev = curr;
        curr = curr.nextPeerOnConn;
      }
    }
  }
}

function peerHasSwarms<ConnectionContext extends Record<string, unknown>>(
  peer: PeerContext<ConnectionContext>,
): boolean {
  return peer.swarmIndex !== -1;
}

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

  readonly #connectionPeers = new Map<
    ConnectionContext,
    PeerContext<ConnectionContext>
  >();

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
        completedCount: 0,
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
      swarm.completedCount++;
    }
  }

  private removePeerFromSwarm(
    swarm: Swarm<ConnectionContext>,
    node: SwarmOnPeer<ConnectionContext>,
  ) {
    if (node.isCompleted) {
      swarm.completedCount--;
    }

    const { swarmIndex } = node;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const lastPeer = swarm.peers.pop()!;
    if (swarmIndex < swarm.peers.length) {
      swarm.peers[swarmIndex] = lastPeer;
      const lastPeerNode = findSwarmOnPeer(lastPeer, swarm);
      if (lastPeerNode !== undefined) {
        lastPeerNode.swarmIndex = swarmIndex;
      }
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
    node: SwarmOnPeer<ConnectionContext>,
  ) {
    if (!node.isCompleted) {
      node.isCompleted = true;
      swarm.completedCount++;
    }
  }

  private startClearPeersInterval(): void {
    this.#clearPeersInterval = setInterval(() => {
      const now = performance.now();
      for (const peer of this.#peers.values()) {
        let prev: SwarmOnPeer<ConnectionContext> | undefined = undefined;
        let curr: SwarmOnPeer<ConnectionContext> | undefined = peer;

        while (curr !== undefined) {
          const next: SwarmOnPeer<ConnectionContext> | undefined =
            curr.nextSwarmOnPeer;
          if (
            now - curr.swarmTime >
            this.settings.announceInterval * 2 * 1000
          ) {
            this.removePeerFromSwarm(curr.swarm, curr);

            // Head-replacement: copy next node's fields into peer.
            // NOTE: Mirrors removeSwarmFromPeer — keep both in sync if SwarmOnPeer fields change.
            if (curr === peer) {
              if (next !== undefined) {
                peer.swarm = next.swarm;
                peer.swarmTime = next.swarmTime;
                peer.swarmIndex = next.swarmIndex;
                peer.isCompleted = next.isCompleted;
                peer.nextSwarmOnPeer = next.nextSwarmOnPeer;
                releaseSwarmNode(next);
                curr = peer;
                continue;
              } else {
                peer.swarmIndex = -1;
              }
            } else if (prev !== undefined) {
              prev.nextSwarmOnPeer = next;
              releaseSwarmNode(curr);
            }
          } else {
            prev = curr;
          }
          curr = next;
        }

        if (!peerHasSwarms(peer)) {
          this.removePeer(peer);
        }
      }
    }, this.settings.announceInterval * 1000);
  }

  private removePeer(peer: PeerContext<ConnectionContext>) {
    if (peer.swarmIndex !== -1) {
      this.removePeerFromSwarm(peer.swarm, peer);
    }

    let nextNode = peer.nextSwarmOnPeer;
    peer.nextSwarmOnPeer = undefined;
    while (nextNode !== undefined) {
      const next: SwarmOnPeer<ConnectionContext> | undefined =
        nextNode.nextSwarmOnPeer;
      if (nextNode.swarmIndex !== -1) {
        this.removePeerFromSwarm(nextNode.swarm, nextNode);
      }
      releaseSwarmNode(nextNode);
      nextNode = next;
    }

    this.#peers.delete(peer.peerId);

    removePeerFromConnection(this.#connectionPeers, peer);

    this.#onRemovePeer?.(peer.peerId, peer.connection);

    releasePeerContext(peer);
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
    let peer: PeerContext<ConnectionContext> | undefined =
      this.#connectionPeers.get(connection);
    if (peer !== undefined) {
      this.#connectionPeers.delete(connection);
      while (peer !== undefined) {
        const next: PeerContext<ConnectionContext> | undefined =
          peer.nextPeerOnConn;
        peer.nextPeerOnConn = undefined; // break reference chain for GC (pool may be full)
        if (debugEnabled) {
          debug(
            "disconnect peer:",
            Buffer.from(peer.peerId).toString("hex"),
            "swarms:",
            getPeerSwarmsInfoHashes(peer),
          );
        }
        this.removePeer(peer);
        peer = next;
      }
    }
  }

  private processAnnounce(
    json: UnknownObject,
    connection: ConnectionContext,
    completed = false,
  ): void {
    const infoHash = json.info_hash as string;
    const peerId = json.peer_id as string;
    if (typeof peerId !== "string") {
      throw new TrackerError("announce: peer_id field is missing or wrong");
    }
    let swarm: Swarm<ConnectionContext> | undefined;
    const isPeerCompleted = completed || json.left === 0;

    let peer = this.#peers.get(peerId);

    if (peer !== undefined && peer.connection !== connection) {
      // The peer previously was on a different connection
      if (debugEnabled) {
        debug(
          "peer changed connection:",
          Buffer.from(peer.peerId).toString("hex"),
        );
      }
      this.removePeer(peer);
      peer = undefined;
    }

    const now = performance.now();

    if (peer === undefined) {
      swarm = this.getOrCreateSwarm(infoHash);

      peer = acquirePeerContext(
        peerId,
        connection,
        now,
        swarm,
        now,
        swarm.peers.length,
        isPeerCompleted,
      );

      this.addPeerToSwarm(swarm, peer, isPeerCompleted);

      addPeerToConnection(this.#connectionPeers, connection, peer);

      this.#peers.set(peerId, peer);
    } else if (peer.peerId === peerId) {
      peer.lastAccessed = now;

      swarm = this.getOrCreateSwarm(infoHash);
      const node = findSwarmOnPeer(peer, swarm);
      if (node === undefined) {
        addSwarmToPeer(peer, swarm, now, swarm.peers.length, isPeerCompleted);
        this.addPeerToSwarm(swarm, peer, isPeerCompleted);
      } else {
        node.swarmTime = now;
        if (isPeerCompleted) {
          this.setPeerCompletedInSwarm(swarm, node);
        }
      }
    } else {
      throw new TrackerError("announce: peerId mismatch");
    }

    const complete = swarm.completedCount;

    reusableAnnounceMessage.interval = this.settings.announceInterval;
    reusableAnnounceMessage.info_hash = infoHash;
    reusableAnnounceMessage.complete = complete;
    reusableAnnounceMessage.incomplete = swarm.peers.length - complete;

    this.#sendMessage(reusableAnnounceMessage, connection);

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
      let offerIdx = 0;
      // eslint-disable-next-line @typescript-eslint/prefer-for-of
      for (let i = 0; i < peers.length; i++) {
        const toPeer = peers[i];
        if (toPeer !== peer) {
          this.#sendMessage(
            getSendOfferJson(
              offers[offerIdx++],
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
    const peerId = json.peer_id as string;
    if (typeof toPeerId !== "string") {
      throw new TrackerError("answer: to_peer_id field is missing or wrong");
    }
    if (typeof peerId !== "string") {
      throw new TrackerError("answer: peer_id field is missing or wrong");
    }

    const toPeer = this.#peers.get(toPeerId);
    if (toPeer === undefined) {
      throw new TrackerError("answer: to_peer_id is not in the swarm");
    }

    delete json.to_peer_id;
    this.#sendMessage(json, toPeer.connection);

    if (debugEnabled) {
      debug(
        "answer: from peer",
        Buffer.from(peerId).toString("hex"),
        "to peer",
        Buffer.from(toPeerId).toString("hex"),
      );
    }
  }

  private processStop(json: UnknownObject): void {
    const peerId = json.peer_id as string;
    if (typeof peerId !== "string") {
      throw new TrackerError("stop: peer_id field is missing or wrong");
    }
    const infoHash = json.info_hash as string;

    const swarm = this.#swarms.get(infoHash);
    if (!swarm) return;

    const peer = this.#peers.get(peerId);
    if (!peer) return;

    const node = findSwarmOnPeer(peer, swarm);
    if (node === undefined) return;

    if (debugEnabled) {
      debug(
        "stop peer:",
        Buffer.from(peer.peerId).toString("hex"),
        "swarm:",
        Buffer.from(infoHash).toString("hex"),
      );
    }

    this.removePeerFromSwarm(swarm, node);
    removeSwarmFromPeer(peer, swarm);

    if (!peerHasSwarms(peer)) {
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
        const complete = swarm.completedCount;
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
          const complete = swarm.completedCount;
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
        const complete = swarm.completedCount;
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
    peerContextPool.length = 0;
    swarmNodePool.length = 0;
    reusableAnnounceMessage.info_hash = "";
    reusableOfferMessage.info_hash = "";
    reusableOfferMessage.offer_id = undefined;
    reusableOfferMessage.peer_id = "";
    reusableOfferMessage.offer.sdp = undefined;
  }
}

function getPeerSwarmsInfoHashes(
  peer: PeerContext<Record<string, unknown>>,
): string {
  let result = "";
  let curr: SwarmOnPeer<Record<string, unknown>> | undefined = peer;
  while (curr !== undefined) {
    if (curr.swarmIndex !== -1) {
      if (result !== "") {
        result += ",";
      }
      result += Buffer.from(curr.swarm.infoHash).toString("hex");
    }
    curr = curr.nextSwarmOnPeer;
  }
  return result;
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

  reusableOfferMessage.info_hash = infoHash;
  reusableOfferMessage.offer_id = offerId;
  reusableOfferMessage.peer_id = fromPeerId;
  reusableOfferMessage.offer.sdp = (offer as UnknownObject).sdp;

  return reusableOfferMessage;
}
