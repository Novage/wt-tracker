import { FastTracker } from "../lib/fast-tracker";
import { PeerContext } from "../lib/tracker";
import { expect } from "chai";

describe("simulation", () => {
    it("should pass random simulations", () => {
        const simulationsCount = 1000;
        const torrentsCount = 3;
        const peersCount = 300;
        const offersCount = 10;
        const sameIdPeersRatio = 0.1;

        const tracker = new FastTracker();

        const peers: PeerContext[] = [];
        const peersData: { infoHash?: string, peerId: string }[] = [];

        for (let i = 0; i < peersCount; i++) {
            peers.push({
                sendMessage: function (json: any) {
                }
            });
            peersData.push({ peerId: (i % Math.floor(peersCount * sameIdPeersRatio)).toString() });
        }

        const announceMessage = {
            action: "announce",
            info_hash: "",
            peer_id: "",
            offers: new Array<any>(),
            numwant: 100
        };

        for (let i = 0; i < offersCount; i++) {
            announceMessage.offers.push({
                offer: {
                    sdp: "x"
                },
                offer_id: i.toString()
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
                        peer_id: peer.id
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

        let activePeersCount = 0;
        const torrents = new Set<string>();

        for (let i = 0; i < peers.length; i++) {
            const peer = peers[i];
            const peerData = peersData[i];

            if (peerData.infoHash) {
                if ((peer as any).swarms.length !== 1) {
                    continue;
                }

                expect((peer as any).swarms[0].swarm.infoHash === peerData.infoHash, "the peer is in a wrong swarm");

                if ((peer as any).swarms[0].swarm.peers.get(peerData.peerId) === peer) {
                    activePeersCount++;
                    torrents.add(peerData.infoHash!);
                }
            } else {
                expect(((peer as any).swarms === undefined) || ((peer as any).swarms.length === 0), "the peer should not be in a swarm");
            }
        }

        expect(tracker.stats.torrentsCount == torrents.size);
        expect(tracker.stats.peersCount == activePeersCount);
    });
});
