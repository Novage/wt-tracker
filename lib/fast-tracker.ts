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

import * as DebugModule from "debug";
import { ldebug as ldebugConstructor } from "./lambda-debug";

const debug = DebugModule("wt-tracker:fast-tracker");
const ldebug = ldebugConstructor(debug);

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

        ldebug(() => ["disconnect peer:", Buffer.from(peerId).toString("hex")]);

        for (const swarmContext of (peer as InternalPeerContext).swarms!) {
            const swarm = swarmContext.swarm;
            swarm.removePeer(peer);
            if (swarm.peers.size === 0) {
                ldebug(() => ["swarm removed (empty)", Buffer.from(swarm.infoHash).toString("hex")]);
                this._swarms.delete(swarm.infoHash);
            } else if (swarmContext.completed) {
                swarm.completedCount--;
            }
        }

        peer.id = undefined;
        (peer as InternalPeerContext).swarms = undefined;
    }

    private processAnnounce(json: any, peer: InternalPeerContext, completed: boolean = false) {
        const infoHash = json.info_hash;
        const peerId = json.peer_id;

        let swarmContext: SwarmContext | undefined;

        if (peer.id === undefined) {
            if (typeof peerId !== "string") {
                throw new TrackerError("announce: peer_id field is missing or wrong");
            }

            peer.id = peerId;
            peer.swarms = [];
        } else {
            if (peer.id !== peerId) {
                throw new TrackerError("announce: different peer_id on the same connection");
            }
            swarmContext = peer.swarms!.find(s => s.swarm.infoHash === infoHash);
        }

        if (swarmContext === undefined) {
            swarmContext = this.addPeerToSwarm(peer, infoHash);
        }

        const swarm = swarmContext.swarm;
        const swarmPeers = swarm.peersOrdered;

        if (!swarmContext.completed && (completed || json.left === 0)) {
            swarmContext.completed = true;
            swarm.completedCount++;
        }

        peer.sendMessage({
            action: "announce",
            interval: this.settings.announceInterval,
            info_hash: infoHash,
            complete: swarm.completedCount,
            incomplete: swarm.peers.size - swarm.completedCount,
        });

        this.sendOffersToPeers(json, swarmPeers, peer, infoHash);
    }

    private addPeerToSwarm(peer: InternalPeerContext, infoHash: any) {
        let swarm = this._swarms.get(infoHash);

        if (swarm === undefined) {
            if (typeof infoHash !== "string") {
                throw new TrackerError("announce: info_hash field is missing or wrong");
            }

            ldebug(() => ["announce: swarm created:", Buffer.from(infoHash).toString("hex")]);
            swarm = new Swarm(infoHash);
            this._swarms.set(infoHash, swarm);
        }

        ldebug(() => ["announce: peer", Buffer.from(peer.id!).toString("hex"), "added to swarm", Buffer.from(infoHash).toString("hex")]);

        const previousPeer = swarm.peers.get(peer.id!);
        if (previousPeer !== undefined) {
            removePeerFromSwarm(previousPeer, infoHash);
        }

        swarm.addPeer(peer);
        const swarmContext = { completed: false, swarm: swarm };
        peer.swarms!.push(swarmContext);

        return swarmContext;
    }

    // tslint:disable-next-line:cognitive-complexity
    private sendOffersToPeers(json: any, peers: ReadonlyArray<InternalPeerContext>, peer: InternalPeerContext, infoHash: string) {
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

    private processAnswer(json: any, peer: InternalPeerContext) {
        const infoHash: string = json.info_hash;
        const peerSwarms = peer.swarms;

        if (peerSwarms === undefined) {
            throw new TrackerError("answer: peer is not in the swarm");
        }

        const swarmContext = peerSwarms.find(s => s.swarm.infoHash === infoHash);

        if (swarmContext === undefined) {
            throw new TrackerError("answer: peer is not in the swarm");
        }

        const toPeerId = json.to_peer_id;
        const toPeer = swarmContext.swarm.peers.get(toPeerId);
        if (toPeer === undefined) {
            throw new TrackerError("answer: to_peer_id is not in the swarm");
        }

        delete json.to_peer_id;
        toPeer.sendMessage(json);

        ldebug(() => ["answer: from peer", Buffer.from(peer.id!).toString("hex"), "to peer", Buffer.from(toPeerId).toString("hex")]);
    }

    private processStop(json: any, peer: InternalPeerContext) {
        const peerId: string | undefined = json.peer_id;
        if (peer.id !== peerId) {
            throw new TrackerError("stop event: different peer_id on the same connection");
        }

        if (peerId === undefined) {
            throw new TrackerError("stop event: no peer_id field in the message");
        }

        const infoHash: string = json.info_hash;

        const swarm = removePeerFromSwarm(peer, infoHash);

        if (swarm === undefined) {
            debug("stop event: peer not in the swarm");
            return;
        }

        ldebug(() => ["stop event: peer", Buffer.from(peerId).toString("hex"), "remove from swarm", Buffer.from(infoHash).toString("hex")]);

        if (swarm.peers.size === 0) {
            ldebug(() => ["stop event: swarm removed (empty)", Buffer.from(infoHash).toString("hex")]);
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
        });
    }
}

interface SwarmContext {
    completed: boolean;
    swarm: Swarm;
}

interface InternalPeerContext extends PeerContext {
    swarms?: SwarmContext[];
}

// tslint:disable-next-line:max-classes-per-file
class Swarm {
    public completedCount = 0;

    private _peers = new Map<string, InternalPeerContext>();
    private _peersOrdered: InternalPeerContext[] = [];

    constructor(readonly infoHash: string) {}

    public addPeer(peer: InternalPeerContext) {
        const peerId = peer.id!;
        this._peersOrdered.push(peer);
        this._peers.set(peerId, peer);
    }

    public removePeer(peer: InternalPeerContext) {
        this._peers.delete(peer.id!);

        // Delete peerId from array without calling splice
        const index = this._peersOrdered.indexOf(peer);
        const last = this._peersOrdered.pop()!;
        if (index < this._peersOrdered.length) {
            this._peersOrdered[index] = last;
        }
    }

    public get peers(): ReadonlyMap<string, InternalPeerContext> {
        return this._peers;
    }

    public get peersOrdered(): ReadonlyArray<InternalPeerContext> {
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
    });
}

function removePeerFromSwarm(peer: InternalPeerContext, infoHash: string): Swarm | undefined {
    const peerSwarms = peer.swarms!;
    const swarmIndex = peerSwarms.findIndex(s => s.swarm.infoHash === infoHash);

    if (swarmIndex === -1) {
        return undefined;
    }

    const swarmContext = peerSwarms[swarmIndex];
    const swarm = swarmContext.swarm;

    swarm.removePeer(peer);
    if (swarmContext.completed) {
        swarm.completedCount--;
    }

    // Delete swarm from array without calling splice
    const last = peerSwarms.pop()!;
    if (swarmIndex < peerSwarms.length) {
        peerSwarms[swarmIndex] = last;
    }

    return swarm;
}
