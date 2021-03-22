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

/* eslint-disable camelcase */

import * as Debug from "debug";
import { Tracker, PeerContext, TrackerError } from "./tracker";

// eslint-disable-next-line new-cap
const debug = Debug("wt-tracker:fast-tracker");
const debugEnabled = debug.enabled;

interface UnknownObject {
    [key: string]: unknown;
}

interface Settings {
    maxOffers: number;
    announceInterval: number;
}

export class FastTracker implements Tracker {
    public readonly settings: Settings;

    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
    readonly #swarms = new Map<string, Swarm>();

    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
    readonly #peers = new Map<string, PeerContext>();

    public constructor(settings?: Partial<Settings>) {
        this.settings = {
            maxOffers: 20,
            announceInterval: 120,
            ...settings,
        };
    }

    public get swarms(): ReadonlyMap<string, { peers: readonly PeerContext[] }> {
        return this.#swarms;
    }

    public processMessage(jsonObject: object, peer: PeerContext): void {
        const json = jsonObject as UnknownObject;
        const action = json.action;

        if (action === "announce") {
            const event = json.event;

            if (event === undefined) {
                if (json.answer === undefined) {
                    this.processAnnounce(json, peer);
                } else {
                    this.processAnswer(json, peer);
                }
            } else if (event === "started") {
                this.processAnnounce(json, peer);
            } else if (event === "stopped") {
                this.processStop(json, peer);
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

    public disconnectPeer(peer: PeerContext): void {
        const peerId = peer.id;
        if (peerId === undefined) {
            return;
        }

        if (debugEnabled) {
            debug("disconnect peer:", Buffer.from(peerId).toString("hex"));
        }

        // eslint-disable-next-line guard-for-in
        for (const infoHash in peer) {
            const swarm = (peer as unknown as UnknownObject)[infoHash];

            if (!(swarm instanceof Swarm)) {
                continue;
            }

            swarm.removePeer(peer);
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete (peer as unknown as UnknownObject)[infoHash];

            if (debugEnabled) {
                debug("disconnect peer: peer", Buffer.from(peerId).toString("hex"), "removed from swarm", Buffer.from(infoHash).toString("hex"));
            }

            if (swarm.peers.length === 0) {
                if (debugEnabled) {
                    debug("disconnect peer: swarm removed (empty)", Buffer.from(swarm.infoHash).toString("hex"));
                }
                this.#swarms.delete(swarm.infoHash);
            }
        }

        this.#peers.delete(peerId);
        peer.id = undefined;
    }

    private processAnnounce(json: UnknownObject, peer: PeerContext, completed = false): void {
        const infoHash = json.info_hash;
        const peerId = json.peer_id;
        let swarm: unknown = undefined;

        if (peer.id === undefined) {
            if (typeof peerId !== "string") {
                throw new TrackerError("announce: peer_id field is missing or wrong");
            }

            peer.id = peerId;

            const oldPeer = this.#peers.get(peerId);
            if (oldPeer !== undefined) {
                this.disconnectPeer(oldPeer);
            }

            this.#peers.set(peerId, peer);
        } else if (peer.id === peerId) {
            swarm = (peer as unknown as UnknownObject)[infoHash as string];
        } else {
            throw new TrackerError("announce: different peer_id on the same connection");
        }

        const isPeerCompleted = (completed || json.left === 0);

        if (swarm === undefined) {
            swarm = this.addPeerToSwarm(peer, infoHash, isPeerCompleted);
        } else if (swarm instanceof Swarm) {
            if (debugEnabled) {
                debug(
                    "announce: peer",
                    Buffer.from(peer.id).toString("hex"),
                    "in swarm",
                    Buffer.from(infoHash as string).toString("hex"),
                );
            }

            if (isPeerCompleted) {
                swarm.setCompleted(peer);
            }
        } else {
            throw new TrackerError("announce: illegal info_hash field");
        }

        peer.sendMessage({
            action: "announce",
            interval: this.settings.announceInterval,
            info_hash: infoHash,
            complete: (swarm as Swarm).completedCount,
            incomplete: (swarm as Swarm).peers.length - (swarm as Swarm).completedCount,
        }, peer);

        this.sendOffersToPeers(json, (swarm as Swarm).peers, peer, infoHash as string);
    }

    private addPeerToSwarm(peer: PeerContext, infoHash: unknown, completed: boolean): Swarm {
        let swarm = this.#swarms.get(infoHash as string);

        if (swarm === undefined) {
            if (typeof infoHash !== "string") {
                throw new TrackerError("announce: info_hash field is missing or wrong");
            }

            if (debugEnabled) {
                debug("announce: swarm created:", Buffer.from(infoHash).toString("hex"));
            }

            swarm = new Swarm(infoHash);
            this.#swarms.set(infoHash, swarm);
        }

        if (debugEnabled) {
            debug(
                "announce: peer",
                Buffer.from(peer.id!).toString("hex"),
                "added to swarm",
                Buffer.from(infoHash as string).toString("hex"),
            );
        }

        swarm.addPeer(peer, completed);
        (peer as unknown as UnknownObject)[infoHash as string] = swarm;
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
        const countOffersToSend = Math.min(countPeersToSend, offers.length, this.settings.maxOffers, numwant);

        if (countOffersToSend === countPeersToSend) {
            // we have offers for all the peers from the swarm - send offers to all
            const offersIterator = (offers as unknown[]).values();
            for (const toPeer of peers) {
                if (toPeer !== peer) {
                    sendOffer(offersIterator.next().value, peer.id!, toPeer, infoHash);
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
                    sendOffer(offers[i], peer.id!, toPeer, infoHash);
                }

                peerIndex++;
                if (peerIndex === peers.length) {
                    peerIndex = 0;
                }
            }
        }

        debug("announce: sent offers", (countOffersToSend < 0) ? 0 : countOffersToSend);
    }

    private processAnswer(json: UnknownObject, peer: PeerContext): void {
        const toPeerId = json.to_peer_id as string;
        const toPeer = this.#peers.get(toPeerId);
        if (toPeer === undefined) {
            throw new TrackerError("answer: to_peer_id is not in the swarm");
        }

        json.peer_id = peer.id;
        delete json.to_peer_id;
        toPeer.sendMessage(json, toPeer);

        if (debugEnabled) {
            debug(
                "answer: from peer",
                Buffer.from(peer.id!).toString("hex"),
                "to peer",
                Buffer.from(toPeerId).toString("hex"),
            );
        }
    }

    private processStop(json: UnknownObject, peer: PeerContext): void {
        const infoHash = json.info_hash;
        const swarm = (peer as unknown as UnknownObject)[infoHash as string];

        if (!(swarm instanceof Swarm)) {
            debug("stop event: peer not in the swarm");
            return;
        }

        if (debugEnabled) {
            debug(
                "stop event: peer",
                Buffer.from(peer.id!).toString("hex"),
                "removed from swarm",
                Buffer.from(infoHash as string).toString("hex"),
            );
        }

        swarm.removePeer(peer);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (peer as unknown as UnknownObject)[infoHash as string];

        if (swarm.peers.length === 0) {
            if (debugEnabled) {
                debug("stop event: swarm removed (empty)", Buffer.from(infoHash as string).toString("hex"));
            }
            this.#swarms.delete(infoHash as string);
        }
    }

    private processScrape(json: UnknownObject, peer: PeerContext): void {
        const infoHash = json.info_hash;
        const files: { [key: string]: { complete: number; incomplete: number; downloaded: number } } = {};

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

        peer.sendMessage({ action: "scrape", files: files }, peer);
    }
}

class Swarm {
    public completedCount = 0;

    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
    readonly #peers: PeerContext[] = [];

    private completedPeers?: Set<string>;

    public constructor(public readonly infoHash: string) { }

    public addPeer(peer: PeerContext, completed: boolean): void {
        this.#peers.push(peer);
        if (completed) {
            if (this.completedPeers === undefined) {
                this.completedPeers = new Set();
            }
            this.completedPeers.add(peer.id!);
            this.completedCount++;
        }
    }

    public removePeer(peer: PeerContext): void {
        const index = this.#peers.indexOf(peer);

        if (this.completedPeers?.delete(peer.id!) === true) {
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

        if (!this.completedPeers.has(peer.id!)) {
            this.completedPeers.add(peer.id!);
            this.completedCount++;
        }
    }

    public get peers(): readonly PeerContext[] {
        return this.#peers;
    }
}

function sendOffer(
    offerItem: unknown,
    fromPeerId: string,
    toPeer: PeerContext,
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
