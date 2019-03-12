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

import { FastTracker } from "../lib/fast-tracker";
import { PeerContext } from "../lib/tracker";
import { expect } from "chai";

// tslint:disable:no-unused-expression

describe("simulation", () => {
    it("should pass random simulations", () => {
        const simulationsCount = 1000;
        const torrentsCount = 2;
        const peersCount = 200;
        const offersCount = 10;
        const sameIdPeersRatio = 0.1;

        const tracker = new FastTracker();

        const peers: PeerContext[] = [];
        const peersData: Array<{ infoHash?: string, peerId: string }> = [];

        for (let i = 0; i < peersCount; i++) {
            peers.push({
                sendMessage: (json: any) => {},
            });
            peersData.push({ peerId: (i % Math.floor(peersCount * sameIdPeersRatio)).toString() });
        }

        const announceMessage = {
            action: "announce",
            info_hash: "",
            peer_id: "",
            offers: new Array<any>(),
            numwant: 100,
        };

        for (let i = 0; i < offersCount; i++) {
            announceMessage.offers.push({
                offer: { sdp: "x" },
                offer_id: i.toString(),
            });
        }

        function doIteration() {
            const peerIndex = Math.floor(Math.random() * peers.length);
            const peer = peers[peerIndex];
            const peerData = peersData[peerIndex];

            if (peerData.infoHash) { // peer has been assigned to a torrent
                const random = Math.random();
                if (random < 0.05) { // leave torrent
                    tracker.processMessage({
                        action: "announce",
                        event: "stopped",
                        info_hash: peerData.infoHash,
                        peer_id: peer.id,
                    }, peer);
                    peerData.infoHash = undefined;

                    return;
                } else if (random < 0.06) { // disconnect
                    tracker.disconnectPeer(peer);
                    peerData.infoHash = undefined;
                    peers[peerIndex] = { sendMessage: peer.sendMessage };
                    return;
                } else { // announce on the same torrent
                    announceMessage.peer_id = peerData.peerId;
                    announceMessage.info_hash = peerData.infoHash;
                    tracker.processMessage(announceMessage, peer);
                    return;
                }
            }

            // assign the peer to a torrent
            announceMessage.peer_id = peerData.peerId;
            announceMessage.info_hash = peerData.infoHash = Math.floor(Math.random() * torrentsCount).toString();
            tracker.processMessage(announceMessage, peer);
        }

        for (let s = 0; s < simulationsCount; s++) {
            doIteration();
        }

        for (const [swarmId, swarm] of tracker.swarms) {
            expect(swarm.peers).to.be.not.empty;
            for (const peer of swarm.peers.values()) {
                const peerData = peersData[peers.indexOf(peer)];
                expect(peerData).to.exist;
                expect(peerData.infoHash).to.be.equal(swarmId);
            }
        }
    });
});
