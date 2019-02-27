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

export class FastTracker implements Tracker {
    private swarms = new Map<string, Swarm>();
    private logLevel: number;

    constructor(readonly settings: any) {
        this.settings = {
            maxOffers: 20,
            logLevel: 0,
            announceInterval: 120,
            ...(settings ? settings : {})
        };

        this.logLevel = this.settings.logLevel;
    }

    public processMessage(json: any, peer: PeerContext) {
        const action: string | undefined | null = json.action;

        if (action === "announce") {
            const event: string | undefined | null = json.event;

            if (event == undefined) {
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
            new TrackerError("unknown action");
        }
    }

    private processAnnounce(json: any, peer: InternalPeerContext, completed: boolean = false) {
        const infoHash: string = json.info_hash;
        const peerId: string = json.peer_id;

        let swarmContext: SwarmContext | undefined = undefined;

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
            let swarm = this.swarms.get(infoHash);

            if (swarm === undefined) {
                if (typeof infoHash !== "string") {
                    throw new TrackerError("announce: info_hash field is missing or wrong");
                }

                if (this.logLevel) console.log("announce: swarm created:", Buffer.from(infoHash).toString("hex"));
                swarm = new Swarm(infoHash);
                this.swarms.set(infoHash, swarm);
            }

            if (this.logLevel) console.log("announce: peer", Buffer.from(peerId).toString("hex"), "added to swarm", Buffer.from(infoHash).toString("hex"));

            const previousPeer = swarm.peers.get(peerId);
            if (previousPeer !== undefined) {
                removePeerFromSwarm(previousPeer, infoHash);
            }

            swarm.addPeer(peer);
            swarmContext = { completed: false, swarm: swarm };
            peer.swarms!.push(swarmContext);
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
            incomplete: swarm.peers.size - swarm.completedCount
        });

        const offers: Array<any> | undefined = json.offers;
        if (offers == undefined) {
            return;
        } else if (!(offers instanceof Array)) {
            throw new TrackerError("announce: offers field is not an array");
        }

        if (swarmPeers.length <= 1) {
            return;
        }

        const numwant = json.numwant;
        if (!Number.isInteger(numwant)) {
            return;
        }

        const countPeersToSend = swarmPeers.length - 1;
        const countOffersToSend = Math.min(countPeersToSend, offers.length, this.settings.maxOffers, numwant);

        if (countOffersToSend == countPeersToSend) {
            // we have offers for all the peers from the swarm - send offers to all
            const offersIterator = offers.values();
            for (const toPeer of swarmPeers) {
                if (toPeer !== peer) {
                    sendOffer(offersIterator.next().value, peerId, toPeer, infoHash);
                }
            }
        } else {
            let peerIndex = Math.floor(Math.random() * swarmPeers.length);
            // send offers to random peers
            for (let i = 0; i < countOffersToSend; i++) {
                const toPeer = swarmPeers[peerIndex];

                if (toPeer === peer) {
                    i--; // do one more iteration
                } else {
                    sendOffer(offers[i], peerId, toPeer, infoHash);
                }

                peerIndex++;
                if (peerIndex == swarmPeers.length) {
                    peerIndex = 0;
                }
            }
        }

        if (this.logLevel) console.log("announce: sent offers", countOffersToSend < 0 ? 0 : countOffersToSend);
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

        if (this.logLevel) console.log("answer: from peer", Buffer.from(peer.id!).toString("hex"), "to peer", Buffer.from(toPeerId).toString("hex"));
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
            if (this.logLevel) console.log("stop event: peer not in the swarm");
            return;
        }

        if (this.logLevel) console.log("stop event: peer", Buffer.from(peerId).toString("hex"), "remove from swarm", Buffer.from(infoHash).toString("hex"));

        if (swarm.peers.size == 0) {
            if (this.logLevel) console.log("stop event: swarm removed (empty)", Buffer.from(infoHash).toString("hex"));
            this.swarms.delete(infoHash);
        }
    }

    public disconnectPeer(peer: PeerContext) {
        const peerId = peer.id;
        if (peerId === undefined) {
            return;
        }

        if (this.logLevel) console.log("disconnect peer:", Buffer.from(peerId).toString("hex"));

        for (const swarmContext of (peer as InternalPeerContext).swarms!) {
            const swarm = swarmContext.swarm;
            swarm.removePeer(peer);
            if (swarm.peers.size == 0) {
                if (this.logLevel) console.log("swarm removed (empty)", Buffer.from(swarm.infoHash).toString("hex"));
                this.swarms.delete(swarm.infoHash);
            } else if (swarmContext.completed) {
                swarm.completedCount--;
            }
        }

        peer.id = undefined;
        (peer as InternalPeerContext).swarms = undefined;
    }

    private processScrape(json: any, peer: PeerContext) {
        const infoHash: any = json.info_hash;
        const files: {[key: string]: { complete: number, incomplete: number, downloaded: number}} = {};

        if (infoHash === undefined) {
            for (const swarm of this.swarms.values()) {
                files[swarm.infoHash] = {
                    complete: swarm.completedCount,
                    incomplete: swarm.peersOrdered.length - swarm.completedCount,
                    downloaded: swarm.completedCount
                };
            }
        } else if (infoHash instanceof Array) {
            for (const singleInfoHash of infoHash) {
                const swarm = this.swarms.get(singleInfoHash);
                if (swarm !== undefined) {
                    files[singleInfoHash] = {
                        complete: swarm.completedCount,
                        incomplete: swarm.peersOrdered.length - swarm.completedCount,
                        downloaded: swarm.completedCount
                    };
                } else if (typeof singleInfoHash === "string") {
                    files[singleInfoHash] = {
                        complete: 0,
                        incomplete: 0,
                        downloaded: 0
                    };
                }
            }
        } else {
            const swarm = this.swarms.get(infoHash);
            if (swarm !== undefined) {
                files[infoHash] = {
                    complete: swarm.completedCount,
                    incomplete: swarm.peersOrdered.length - swarm.completedCount,
                    downloaded: swarm.completedCount
                };
            } else if (typeof infoHash === "string") {
                files[infoHash] = {
                    complete: 0,
                    incomplete: 0,
                    downloaded: 0
                };
            }
        }

        peer.sendMessage({
            action: "scrape",
            files: files
        });
    }

    public get stats() {
        let peersCount = 0;
        for (const swarm of this.swarms.values()) {
            peersCount += swarm.peers.size;
        }
        return {
            torrentsCount: this.swarms.size,
            peersCount: peersCount
        };
    }
}

interface SwarmContext {
    completed: boolean;
    swarm: Swarm;
}

interface InternalPeerContext extends PeerContext {
    swarms?: SwarmContext[];
}

class Swarm {
    private peers_ = new Map<string, InternalPeerContext>();
    private peersOrdered_: InternalPeerContext[] = [];
    public completedCount = 0;

    constructor(readonly infoHash: string) {}

    public addPeer(peer: InternalPeerContext) {
        const peerId = peer.id!;
        this.peersOrdered_.push(peer);
        this.peers_.set(peerId, peer);
    }

    public removePeer(peer: InternalPeerContext) {
        this.peers_.delete(peer.id!);

        // Delete peerId from array without calling splice
        const index = this.peersOrdered_.indexOf(peer);
        const last = this.peersOrdered_.pop()!;
        if (index < this.peersOrdered_.length) {
            this.peersOrdered_[index] = last;
        }
    }

    public get peers(): ReadonlyMap<string, InternalPeerContext> {
        return this.peers_;
    }

    public get peersOrdered(): ReadonlyArray<InternalPeerContext> {
        return this.peersOrdered_;
    }
}

function sendOffer(offerItem: {offer?: { sdp?: string }, offer_id?: string } | null, fromPeerId: string, toPeer: PeerContext, infoHash: string) {
    if (offerItem == null) {
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
            sdp: offer.sdp // offer.sdp is not validated to be a string
        }
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
