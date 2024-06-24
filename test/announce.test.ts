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

import { FastTracker } from "../src/fast-tracker.js";
import { describe, it, expect } from "vitest";

describe("announce", () => {
  it("should add peers to swarms on announce", () => {
    const tracker = new FastTracker();

    const peer0 = {
      sendMessage: () => {},
    };
    let announceMessage = {
      action: "announce",
      event: "started",
      info_hash: "swarm1",
      peer_id: "0",
      offers: new Array<unknown>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer0);

    const peerContext0 = tracker.swarms
      .get("swarm1")
      ?.peers.find((pd) => pd.peerId === "0");

    expect(tracker.swarms).to.have.all.keys("swarm1");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(1);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
    ]);

    const peer1 = {
      sendMessage: () => {},
    };
    announceMessage = {
      action: "announce",
      info_hash: "swarm1",
      peer_id: "1",
      offers: new Array<unknown>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer1);

    const peerContext1 = tracker.swarms
      .get("swarm1")
      ?.peers.find((pd) => pd.peerId === "1");

    expect(tracker.swarms).to.have.all.keys("swarm1");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(2);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
      peerContext1,
    ]);

    announceMessage = {
      action: "announce",
      event: "started",
      info_hash: "swarm1",
      peer_id: "1",
      offers: new Array<unknown>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer1);

    expect(tracker.swarms).to.have.all.keys("swarm1");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(2);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
      peerContext1,
    ]);

    const peer2 = {
      sendMessage: () => {},
    };
    announceMessage = {
      action: "announce",
      event: "completed",
      info_hash: "swarm2",
      peer_id: "2_0",
      offers: new Array<any>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer2);

    const peerContext2_2 = tracker.swarms
      .get("swarm2")
      ?.peers.find((pd) => pd.peerId === "2_0");

    expect(tracker.swarms).to.have.all.keys("swarm1", "swarm2");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(2);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
      peerContext1,
    ]);
    expect(tracker.swarms.get("swarm2")!.peers).to.have.lengthOf(1);
    expect(tracker.swarms.get("swarm2")!.peers).to.include.members([
      peerContext2_2,
    ]);

    const peer3 = {
      sendMessage: () => {},
    };
    announceMessage = {
      action: "announce",
      event: "completed",
      info_hash: "swarm2",
      peer_id: "2_1",
      offers: new Array<unknown>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer3);

    const peerContext2_1 = tracker.swarms
      .get("swarm2")!
      .peers.find((pd) => pd.peerId === "2_1");

    expect(tracker.swarms).to.have.all.keys("swarm1", "swarm2");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(2);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
      peerContext1,
    ]);
    expect(tracker.swarms.get("swarm2")!.peers).to.have.lengthOf(2);
    expect(tracker.swarms.get("swarm2")!.peers).to.include.members([
      peerContext2_1,
      peerContext2_2,
    ]);

    announceMessage = {
      action: "announce",
      event: "completed",
      info_hash: "swarm2",
      peer_id: "1",
      offers: new Array<unknown>(),
      numwant: 100,
    };
    tracker.processMessage(announceMessage, peer1);

    expect(tracker.swarms).to.have.all.keys("swarm1", "swarm2");
    expect(tracker.swarms.get("swarm1")!.peers).to.have.lengthOf(1);
    expect(tracker.swarms.get("swarm1")!.peers).to.include.members([
      peerContext0,
    ]);
    expect(tracker.swarms.get("swarm2")!.peers).to.have.lengthOf(3);
    expect(tracker.swarms.get("swarm2")!.peers).to.include.members([
      peerContext1,
      peerContext2_1,
      peerContext2_2,
    ]);
  });
});
