import { FastTracker } from "../../lib/fast-tracker";
import { Tracker } from "../../lib/tracker";

// tslint:disable:no-console

function sendMessage() {}
const peersCount = 100000;
const offersCount = 10;
const peers: any[] = [];

const message = {
    action: "announce",
    event: "started",
    info_hash: "hash",
    peer_id: "",
    offers: new Array<any>(),
    numwant: offersCount,
};

for (let i = 0; i < offersCount; i++) {
    message.offers.push({
        offer: {
            sdp: "x",
            value: 1,
        },
        offer_id: "t",
    });
}

function addingPeersToSwarm(tracker: Tracker) {
    peers.length = 0;
    for (let i = 0; i < peersCount; i++) {
        peers.push({
            sendMessage: sendMessage,
            _peerId: i.toString(),
        });
    }

    console.time(`adding peers to a swarm ${tracker.constructor.name}`);
    for (let i = 0; i < peersCount; i++) {
        const peer = peers[i];
        message.peer_id = peer._peerId;
        tracker.processMessage(message, peer);
    }
    console.timeEnd(`adding peers to a swarm ${tracker.constructor.name}`);
}

// tslint:disable-next-line:cognitive-complexity
function addingPeersToSwarmReference() {
    peers.length = 0;
    for (let i = 0; i < peersCount; i++) {
        peers.push({
            id: i.toString(),
        });
    }

    const swarm = new Map<string, any>();
    const peersOrdered = [];
    let counter = 0;

    console.time("adding peers to a swarm reference");
    for (let p = 0; p < peersCount; p++) {
        const peer = peers[p];

        swarm.set(peer.id, peer);
        peersOrdered.push(peer);

        message.peer_id = peer._peerId;
        const offers = message.offers;
        const countOffersToSend = Math.min(swarm.size - 1, offers.length, 20);
        if (countOffersToSend === swarm.size - 1) {
            const offersIterator = offers.values();
            for (const toPeer of swarm.values()) {
                if (toPeer !== peer) {
                    counter += offersIterator.next().value.offer.value;
                }
            }
        } else {
            let peerIndex = Math.floor(Math.random() * swarm.size);

            // send offers to random peers
            for (let i = 0; i < countOffersToSend; i++) {
                const toPeer = peersOrdered[peerIndex];

                peerIndex++;
                if (peerIndex === swarm.size) {
                    peerIndex = 0;
                }

                if (toPeer === peer) {
                    i--; // do one more iteration
                } else {
                    counter += offers[i].offer.value;
                }
            }
        }
    }
    console.timeEnd("adding peers to a swarm reference");
    console.log(counter);
}

for (let i = 0; i < 10; i++) {
    addingPeersToSwarm(new FastTracker({}));
    addingPeersToSwarmReference();
    console.log("---------");
}
