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

 // tslint:disable

import { FastTracker } from "../../lib/fast-tracker";

const peersCount = 100000;
const swarmsCount = 1000000000;

const message = {
    action: "announce",
    event: "started",
    info_hash: "hash",
    peer_id: "",
    offers: new Array<any>(),
    numwant: 10,
};

for (let o = 0; o < message.numwant; o++) {
    message.offers.push({
        offer: {
            sdp: "x",
            value: 1,
        },
        offer_id: "t",
    });
}

const tracker = new FastTracker();

console.log("heap", process.memoryUsage());
console.log("bytes per peer in average: " + process.memoryUsage().heapUsed / peersCount);
console.log("\nadding peers to swarms");

const peers: any[] = [];
for (let p = 0; p < peersCount; p++) {
    message.peer_id = p.toPrecision(19).toString();
    message.info_hash = Math.floor(swarmsCount * Math.random()).toPrecision(19).toString();
    const peer = {
        sendMessage: () => p,
    };
    tracker.processMessage(message, peer);
    peers.push(peer);
}

let peersCountAfter = 0;
for (const swarm of tracker.swarms.values()) {
    peersCountAfter += swarm.peers.length;
}

console.log("swarms:", tracker.swarms.size, "peers:", peersCountAfter);
console.log("heap:", process.memoryUsage());
console.log("bytes per peer in average: " + process.memoryUsage().heapUsed / peersCount);

console.log("\nremoving peers");

for (const peer of peers) {
    tracker.disconnectPeer(peer);
}

peers.length = 0;

if (global.gc) {
    global.gc();
}

console.log("heap:", process.memoryUsage());
console.log("bytes per peer in average:" + process.memoryUsage().heapUsed / peersCount);
