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

import { Tracker, PeerContext, TrackerError } from "./tracker";

import * as Debug from "debug";

const debug = Debug("wt-tracker:fast-tracker");
const debugEnabled = debug.enabled;

export class FastTracker implements Tracker {
    private _swarms = new Map<string, Swarm>();

    constructor(readonly settings: any = {}) {
        this.settings = {
            maxOffers: 20,
            announceInterval: 120,
            ...(settings ? settings : {}),
        };
    }

    public get swarms(): ReadonlyMap<string, { peers: ReadonlyMap<string, PeerContext> }> {
        return this._swarms;
    }

    public processMessage(json: any, peer: PeerContext) {
        const action: any = json.action;

        if (action === "announce") {
            const event: any = json.event;

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

    public disconnectPeer(peer: PeerContext) {
        const peerId = peer.id;
        if (peerId === undefined) {
            return;
        }

        if (debugEnabled) {
            debug("disconnect peer:", Buffer.from(peerId).toString("hex"));
        }

        for (const swarm of this._swarms.values()) {
            if (!swarm.removePeer(peer)) {
                continue;
            }

            if (debugEnabled) {
                debug("disconnect peer: peer", Buffer.from(peerId).toString("hex"),
                    "removed from swarm", Buffer.from(swarm.infoHash).toString("hex"));
            }

            if (swarm.peers.size === 0) {
                if (debugEnabled) {
                    debug("disconnect peer: swarm removed (empty)", Buffer.from(swarm.infoHash).toString("hex"));
                }
                this._swarms.delete(swarm.infoHash);
            }
        }

        peer.id = undefined;
    }

    private processAnnounce(json: any, peer: PeerContext, completed: boolean = false) {
        const infoHash = json.info_hash;
        const peerId = json.peer_id;

        if (peer.id === undefined) {
            if (typeof peerId !== "string") {
                throw new TrackerError("announce: peer_id field is missing or wrong");
            }

            peer.id = peerId;
        } else if (peer.id !== peerId) {
            throw new TrackerError("announce: different peer_id on the same connection");
        }

        const swarm = this.processPeerInSwarm(peer, infoHash, completed || json.left === 0);

        peer.sendMessage({
            action: "announce",
            interval: this.settings.announceInterval,
            info_hash: infoHash,
            complete: swarm.completedCount,
            incomplete: swarm.peers.size - swarm.completedCount,
        }, peer);

        this.sendOffersToPeers(json, swarm.peersOrdered, peer, infoHash);
    }

    private processPeerInSwarm(peer: PeerContext, infoHash: any, completed: boolean) {
        let swarm = this._swarms.get(infoHash);

        if (swarm === undefined) {
            if (typeof infoHash !== "string") {
                throw new TrackerError("announce: info_hash field is missing or wrong");
            }

            if (debugEnabled) {
                debug("announce: swarm created:", Buffer.from(infoHash).toString("hex"));
            }

            swarm = new Swarm(infoHash);
            this._swarms.set(infoHash, swarm);
        }

        const peerAlreadyInSwarm = swarm.peers.get(peer.id!);
        if (peerAlreadyInSwarm === peer) {
            if (completed) {
                swarm.setCompleted(peer);
            }

            if (debugEnabled) {
                debug("announce: peer", Buffer.from(peer.id!).toString("hex"), " in swarm", Buffer.from(infoHash).toString("hex"));
            }

            return swarm;
        } else if (peerAlreadyInSwarm !== undefined) {
            swarm.removePeer(peerAlreadyInSwarm);
        }

        if (debugEnabled) {
            debug("announce: peer", Buffer.from(peer.id!).toString("hex"), "added to swarm", Buffer.from(infoHash).toString("hex"));
        }

        swarm.addPeer(peer, completed);
        return swarm;
    }

    // tslint:disable-next-line:cognitive-complexity
    private sendOffersToPeers(json: any, peers: ReadonlyArray<PeerContext>, peer: PeerContext, infoHash: string) {
        if (peers.length <= 1) {
            return;
        }

        const offers: any = json.offers;
        if (offers == undefined) {
            return;
        } else if (!(offers instanceof Array)) {
            throw new TrackerError("announce: offers field is not an array");
        }

        const numwant = json.numwant;
        if (!Number.isInteger(numwant)) {
            return;
        }

        const countPeersToSend = peers.length - 1;
        const countOffersToSend = Math.min(countPeersToSend, offers.length, this.settings.maxOffers, numwant);

        if (countOffersToSend === countPeersToSend) {
            // we have offers for all the peers from the swarm - send offers to all
            const offersIterator = offers.values();
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

        debug("announce: sent offers", countOffersToSend < 0 ? 0 : countOffersToSend);
    }

    private processAnswer(json: any, peer: PeerContext) {
        const infoHash: string = json.info_hash;
        const swarm = this._swarms.get(infoHash);

        if (swarm === undefined) {
            throw new TrackerError("answer: no such swarm");
        }

        const toPeerId = json.to_peer_id;
        const toPeer = swarm.peers.get(toPeerId);
        if (toPeer === undefined) {
            throw new TrackerError("answer: to_peer_id is not in the swarm");
        }

        delete json.to_peer_id;
        toPeer.sendMessage(json, toPeer);

        if (debugEnabled) {
            debug("answer: from peer",
                    peer.id === undefined ? "unkown peer" : Buffer.from(peer.id).toString("hex"),
                    "to peer", Buffer.from(toPeerId).toString("hex"));
        }
    }

    private processStop(json: any, peer: PeerContext) {
        if (peer.id === undefined) {
            return;
        }

        const peerId: string | undefined = json.peer_id;
        if (peer.id !== peerId) {
            throw new TrackerError("stop event: different peer_id on the same connection");
        }

        if (peerId === undefined) {
            throw new TrackerError("stop event: no peer_id field in the message");
        }

        const infoHash: string = json.info_hash;

        const swarm = this._swarms.get(infoHash);

        if (swarm === undefined) {
            debug("stop event: peer not in the swarm");
            return;
        }

        if (debugEnabled) {
            debug("stop event: peer", Buffer.from(peerId).toString("hex"), "removed from swarm", Buffer.from(infoHash).toString("hex"));
        }

        swarm.removePeer(peer);
        if (swarm.peers.size === 0) {
            if (debugEnabled) {
                debug("stop event: swarm removed (empty)", Buffer.from(infoHash).toString("hex"));
            }
            this._swarms.delete(infoHash);
        }
    }

    private processScrape(json: any, peer: PeerContext) {
        const infoHash: any = json.info_hash;
        const files: {[key: string]: { complete: number, incomplete: number, downloaded: number}} = {};

        if (infoHash === undefined) {
            for (const swarm of this._swarms.values()) {
                files[swarm.infoHash] = {
                    complete: swarm.completedCount,
                    incomplete: swarm.peersOrdered.length - swarm.completedCount,
                    downloaded: swarm.completedCount,
                };
            }
        } else if (infoHash instanceof Array) {
            for (const singleInfoHash of infoHash) {
                const swarm = this._swarms.get(singleInfoHash);
                if (swarm !== undefined) {
                    files[singleInfoHash] = {
                        complete: swarm.completedCount,
                        incomplete: swarm.peersOrdered.length - swarm.completedCount,
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
            const swarm = this._swarms.get(infoHash);
            if (swarm !== undefined) {
                files[infoHash] = {
                    complete: swarm.completedCount,
                    incomplete: swarm.peersOrdered.length - swarm.completedCount,
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

        peer.sendMessage({
            action: "scrape",
            files: files,
        }, peer);
    }
}

// tslint:disable-next-line:max-classes-per-file
class Swarm {
    public completedCount = 0;

    private _peers = new Map<string, PeerContext>();
    private _peersOrdered: PeerContext[] = [];
    private isPeerCompleted: boolean[] = [];

    constructor(readonly infoHash: string) {}

    public addPeer(peer: PeerContext, completed: boolean) {
        const peerId = peer.id!;
        this._peersOrdered.push(peer);
        this.isPeerCompleted.push(completed);
        this._peers.set(peerId, peer);
        if (completed) {
            this.completedCount++;
        }
    }

    public removePeer(peer: PeerContext) {
        if (!this._peers.delete(peer.id!)) {
            return false;
        }

        const index = this._peersOrdered.indexOf(peer);

        if (this.isPeerCompleted[index]) {
            this.completedCount--;
        }

        // Delete peerId from arrays without calling splice
        const last = this._peersOrdered.pop()!;
        const lastIsCompleted = this.isPeerCompleted.pop()!;
        if (index < this._peersOrdered.length) {
            this._peersOrdered[index] = last;
            this.isPeerCompleted[index] = lastIsCompleted;
        }

        return true;
    }

    public setCompleted(peer: PeerContext) {
        const index = this._peersOrdered.indexOf(peer);

        if (!this.isPeerCompleted[index]) {
            this.completedCount++;
            this.isPeerCompleted[index] = true;
        }
    }

    public get peers(): ReadonlyMap<string, PeerContext> {
        return this._peers;
    }

    public get peersOrdered(): ReadonlyArray<PeerContext> {
        return this._peersOrdered;
    }
}

function sendOffer(offerItem: {offer?: { sdp?: string }, offer_id?: string } | null, fromPeerId: string, toPeer: PeerContext, infoHash: string) {
    if (offerItem === null) {
        throw new TrackerError("announce: wrong offer item format");
    }

    const offer = offerItem.offer;
    const offerId = offerItem.offer_id;

    if (offer == undefined) {
        throw new TrackerError("announce: wrong offer item field format");
    }

    toPeer.sendMessage({
        action: "announce",
        info_hash: infoHash,
        offer_id: offerId, // offerId is not validated to be a string
        peer_id: fromPeerId,
        offer: {
            type: "offer",
            sdp: offer.sdp, // offer.sdp is not validated to be a string
        },
    }, toPeer);
}
