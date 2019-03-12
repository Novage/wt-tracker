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

describe("announce", () => {
    it("should add peers to swarms on announce", () => {

        const tracker = new FastTracker();
        const peers: PeerContext[] = [];

        peers.push({
            sendMessage: (json: any) => {},
        });

        let announceMessage: any = {
            action: "announce",
            event: "started",
            info_hash: "swarm1",
            peer_id: "0",
            offers: new Array<any>(),
            numwant: 100,
        };

        tracker.processMessage(announceMessage, peers[0]);
        expect(tracker.swarms).to.have.all.keys("swarm1");
        expect(tracker.swarms.get("swarm1").peers).to.have.all.keys("0");
        expect(tracker.swarms.get("swarm1").peers.get("0")).to.equal(peers[0]);

        peers.push({
            sendMessage: (json: any) => {},
        });

        announceMessage = {
            action: "announce",
            info_hash: "swarm1",
            peer_id: "1",
            offers: new Array<any>(),
            numwant: 100,
        };

        tracker.processMessage(announceMessage, peers[1]);
        expect(tracker.swarms).to.have.all.keys("swarm1");
        expect(tracker.swarms.get("swarm1").peers).to.have.all.keys("0", "1");
        expect(tracker.swarms.get("swarm1").peers.get("0")).to.equal(peers[0]);
        expect(tracker.swarms.get("swarm1").peers.get("1")).to.equal(peers[1]);

        announceMessage = {
            action: "announce",
            event: "started",
            info_hash: "swarm1",
            peer_id: "1",
            offers: new Array<any>(),
            numwant: 100,
        };

        tracker.processMessage(announceMessage, peers[1]);
        expect(tracker.swarms).to.have.all.keys("swarm1");
        expect(tracker.swarms.get("swarm1").peers).to.have.all.keys("0", "1");
        expect(tracker.swarms.get("swarm1").peers.get("0")).to.equal(peers[0]);
        expect(tracker.swarms.get("swarm1").peers.get("1")).to.equal(peers[1]);

        peers.push({
            sendMessage: (json: any) => {},
        });

        announceMessage = {
            action: "announce",
            event: "completed",
            info_hash: "swarm2",
            peer_id: "2_0",
            offers: new Array<any>(),
            numwant: 100,
        };

        tracker.processMessage(announceMessage, peers[2]);
        expect(tracker.swarms).to.have.all.keys("swarm1", "swarm2");
        expect(tracker.swarms.get("swarm1").peers).to.have.all.keys("0", "1");
        expect(tracker.swarms.get("swarm1").peers.get("0")).to.equal(peers[0]);
        expect(tracker.swarms.get("swarm1").peers.get("1")).to.equal(peers[1]);
        expect(tracker.swarms.get("swarm2").peers).to.have.all.keys("2_0");
        expect(tracker.swarms.get("swarm2").peers.get("2_0")).to.equal(peers[2]);

        peers.push({
            sendMessage: (json: any) => {},
        });

        announceMessage = {
            action: "announce",
            event: "completed",
            info_hash: "swarm2",
            peer_id: "2_1",
            offers: new Array<any>(),
            numwant: 100,
        };

        tracker.processMessage(announceMessage, peers[3]);
        expect(tracker.swarms).to.have.all.keys("swarm1", "swarm2");
        expect(tracker.swarms.get("swarm1").peers).to.have.all.keys("0", "1");
        expect(tracker.swarms.get("swarm1").peers.get("0")).to.equal(peers[0]);
        expect(tracker.swarms.get("swarm1").peers.get("1")).to.equal(peers[1]);
        expect(tracker.swarms.get("swarm2").peers).to.have.all.keys("2_0", "2_1");
        expect(tracker.swarms.get("swarm2").peers.get("2_0")).to.equal(peers[2]);
        expect(tracker.swarms.get("swarm2").peers.get("2_1")).to.equal(peers[3]);
    });
});
