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

import * as WebSocket from "ws";

// tslint:disable:no-console

const peersCount = 10000;
const swarmsCount = 10;
const offersCount = 10;

const offers = new Array<any>();

for (let o = 0; o < offersCount; o++) {
    offers.push({
        offer: {
            sdp: "asdfasdfasdfasdfasdfasdfasdf",
            value: 1,
        },
        offer_id: "taasdfasdfasdfasd",
    });
}

const closePromises = new Array<Promise<void>>();
const connectPromises = new Array<Promise<void>>();

console.log("creating", peersCount, "connections");

async function timeout(milliseconds: number) {
    return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

// tslint:disable-next-line:cognitive-complexity
async function main() {
    try {
        for (let p = 0; p < peersCount; p++) {
            const webSocket = new WebSocket("ws://localhost:8000/");

            closePromises.push(new Promise((resolve, reject) => {
                webSocket.on("close", resolve);
                webSocket.on("error", e => reject(new Error(`Socket closed ${e}`)));
            }));

            connectPromises.push(new Promise((resolve, reject) => {
                webSocket.on("open", () => {
                    try {
                        webSocket.send(JSON.stringify({
                            action: "announce",
                            event: "started",
                            info_hash: Math.floor(swarmsCount * Math.random()).toPrecision(19).toString(),
                            peer_id: p.toPrecision(19).toString(),
                            numwant: offersCount,
                            offers: offers,
                        }));
                        resolve();
                    } catch (e) {
                        reject(new Error(`Send error ${e}`));
                    }
                });
                webSocket.on("message", message => {
                    const json = JSON.parse(message as string);

                    if (!json.offer) {
                        return;
                    }

                    try {
                        webSocket.send(JSON.stringify({
                            action: "announce",
                            info_hash: json.info_hash,
                            peer_id: p.toPrecision(19).toString(),
                            to_peer_id: json.peer_id,
                            answer: {
                                type: "answer",
                                sdp: "xxxxxxxxxxxx",
                            },
                        }));
                    } catch (e) {
                        reject(new Error(`Send error ${e}`));
                    }
                });
                webSocket.on("close", () => reject(new Error("Socket closed")));
                webSocket.on("error", e => reject(new Error(`Socket closed ${e}`)));
            }));

            await timeout(10);
        }
    } catch (e) {
        console.log("faied to create WebSocket connections", e);
        return;
    }

    try {
        await Promise.all(connectPromises);
    } catch (e) {
        console.log("socket error:", e);
        return;
    }

    console.log("waiting for the connections to close");

    try {
        await Promise.all(closePromises);
    } catch (e) {
        console.log("socket error:", e);
    }

    console.log("done");
}

main();
