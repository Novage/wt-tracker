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

import * as uWebSockets from "uWebSockets.js";
import { Tracker, PeerContext, TrackerError } from "./tracker";
import { StringDecoder } from "string_decoder";

// TODO: configure host once segmentation fault fixed in next to 15.1.0 release

export class UWebSocketsTracker {
    private app_: any;
    private logLevel: number;
    private webSocketsCount: number = 0;

    get app() {
        return this.app_;
    }

    get stats() {
        return {
            webSocketsCount: this.webSocketsCount
        };
    }

    constructor(readonly tracker: Tracker, readonly settings: any = {}) {
        this.settings = {
            server: {
                port: 8000,
                ...((settings && settings.server) ? settings.server : {})
            },
            websockets: {
                path: "/",
                maxPayloadLength: 64 * 1024,
                idleTimeout: 240,
                compression: 1,
                logLevel: 0,
                ...((settings && settings.websockets) ? settings.websockets : {})
            }
        };

        this.logLevel = this.settings.websockets.logLevel;

        this.app_ = this.settings.server.key_file_name === undefined
                ? uWebSockets.App(this.settings.server)
                : uWebSockets.SSLApp(this.settings.server);

        this.buildApplication();
    }

    private buildApplication() {
        const decoder = new StringDecoder();

        this.app_
        .ws(this.settings.websockets.path, {
            compression: this.settings.websockets.compression,
            maxPayloadLength: this.settings.websockets.maxPayloadLength,
            idleTimeout: this.settings.websockets.idleTimeout,
            open: (ws: any, request: any) => {
                this.webSocketsCount++;
                if (this.logLevel === 1) console.info("ws connected via URL", request.getUrl());
            },
            message: (ws: any, message: ArrayBuffer, isBinary: boolean) => {
                if (this.logLevel === 2) console.info("ws message of size", message.byteLength);

                let json;
                try {
                    json = JSON.parse(decoder.end(new Uint8Array(message) as any));
                } catch (e) {
                    if (this.logLevel === 1) console.warn("failed to parse JSON message", e);
                    ws.close();
                    return;
                }

                let peer: PeerContext | undefined = ws.peer;

                if (this.logLevel === 2) console.log("in", (peer && peer.id) ? Buffer.from(peer.id).toString("hex") : "unknown peer", json);

                if (peer === undefined) {
                    peer = {
                        sendMessage: (json: any) => {
                            ws.send(JSON.stringify(json), false, false);
                            if (this.logLevel === 2) console.log("out", peer!.id ? Buffer.from(peer!.id).toString("hex") : "unknown peer", json);
                        }
                    };
                    ws.peer = peer;
                }

                try {
                    this.tracker.processMessage(json, peer);
                } catch (e) {
                    if (e instanceof TrackerError) {
                        if (this.logLevel === 1) console.log("failed to process message from the peer:", e);
                    } else {
                        throw e;
                    }
                    ws.close();
                    return;
                }
            },
            drain: (ws: any) => {
                if (this.logLevel === 1) console.info("ws backpressure", ws.getBufferedAmount());
            },
            close: (ws: any, code: number, message: ArrayBuffer) => {
                this.webSocketsCount--;
                const peer: PeerContext | undefined = ws.peer;

                if (peer !== undefined) {
                    delete ws.peer;
                    this.tracker.disconnectPeer(peer);
                }

                if (this.logLevel === 1) console.info("ws closed with code", code);
            }
        });
    }

    public run() {
        this.app_.listen(this.settings.server.port, (token: any) => {
            if (token) {
                console.info("listening to port", this.settings.server.port);
            } else {
                console.error("failed to listen to port", this.settings.server.port);
            }
        });
    }
}
