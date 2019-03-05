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

import { App, SSLApp, WebSocket, HttpRequest, TemplatedApp } from "uWebSockets.js";
import { Tracker, PeerContext, TrackerError } from "./tracker";
import { StringDecoder } from "string_decoder";

import * as Debug from "debug";
import { ldebug } from "./lambda-debug";

const debugWebSockets = Debug("wt-tracker:uws-tracker");
const ldebugMessages = ldebug(Debug("wt-tracker:uws-tracker-messages"));
const decoder = new StringDecoder();

export class UWebSocketsTracker {
    private app_: TemplatedApp;
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
                host: "0.0.0.0",
                ...((settings && settings.server) ? settings.server : {})
            },
            websockets: {
                path: "/",
                maxPayloadLength: 64 * 1024,
                idleTimeout: 240,
                compression: 1,
                ...((settings && settings.websockets) ? settings.websockets : {})
            }
        };

        this.app_ = this.settings.server.key_file_name === undefined
                ? App(this.settings.server)
                : SSLApp(this.settings.server);

        this.buildApplication();
    }

    private buildApplication() {
        this.app_
        .ws(this.settings.websockets.path, {
            compression: this.settings.websockets.compression,
            maxPayloadLength: this.settings.websockets.maxPayloadLength,
            idleTimeout: this.settings.websockets.idleTimeout,
            open: (ws: WebSocket, request: HttpRequest) => {
                this.webSocketsCount++;
                debugWebSockets("connected via URL", request.getUrl());
            },
            drain: (ws: WebSocket) => {
                debugWebSockets("drain", ws.getBufferedAmount());
            },
            message: this.onMessage,
            close: this.onClose
        });
    }

    private onMessage = (ws: WebSocket, message: ArrayBuffer, isBinary: boolean) => {
        debugWebSockets("message of size", message.byteLength);

        let json: any;
        try {
            json = JSON.parse(decoder.end(new Uint8Array(message) as any));
        } catch (e) {
            debugWebSockets("failed to parse JSON message", e);
            ws.close();
            return;
        }

        let peer: PeerContext | undefined = (ws as any).peer;

        ldebugMessages(() => ["in",
                (peer && peer.id) ? Buffer.from(peer.id).toString("hex") : "unknown peer", json]);

        if (peer === undefined) {
            peer = {
                sendMessage: (json: any) => {
                    ws.send(JSON.stringify(json), false, false);
                    ldebugMessages(() => ["out",
                            peer!.id ? Buffer.from(peer!.id).toString("hex") : "unknown peer", json]);
                }
            };
            (ws as any).peer = peer;
        }

        try {
            this.tracker.processMessage(json, peer);
        } catch (e) {
            if (e instanceof TrackerError) {
                debugWebSockets("failed to process message from the peer:", e);
            } else {
                throw e;
            }
            ws.close();
            return;
        }
    }

    private onClose = () => (ws: WebSocket, code: number, message: ArrayBuffer) => {
        this.webSocketsCount--;
        const peer: PeerContext | undefined = (ws as any).peer;

        if (peer !== undefined) {
            delete (ws as any).peer;
            this.tracker.disconnectPeer(peer);
        }

        debugWebSockets("closed with code", code);
    }

    public async run() {
        let resolve: () => void;
        let reject: (error: any) => void;

        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });

        this.app_.listen(this.settings.server.host, this.settings.server.port, (token: any) => {
            if (token) {
                resolve();
            } else {
                reject(new Error(`failed to listen to ${this.settings.server.host}:${this.settings.server.port}`));
            }
        });

        return promise;
    }
}
