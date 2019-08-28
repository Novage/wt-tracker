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
import { Tracker, TrackerError } from "./tracker";
import { StringDecoder } from "string_decoder";
import * as Debug from "debug";

const debugWebSockets = Debug("wt-tracker:uws-tracker");
const debugWebSocketsEnabled = debugWebSockets.enabled;

const debugMessages = Debug("wt-tracker:uws-tracker-messages");
const debugMessagesEnabled = debugMessages.enabled;

const debugRequests = Debug("wt-tracker:uws-tracker-requests");
const debugRequestsEnabled = debugRequests.enabled;

const decoder = new StringDecoder();

export class UWebSocketsTracker {
    private _app: TemplatedApp;
    private webSocketsCount: number = 0;
    private validateOrigin = false;
    private maxConnections = 0;

    get app() {
        return this._app;
    }

    get stats() {
        return {
            webSocketsCount: this.webSocketsCount,
        };
    }

    constructor(readonly tracker: Tracker, readonly settings: any = {}) {
        this.settings = {
            server: {
                port: 8000,
                host: "0.0.0.0",
                ...((settings && settings.server) ? settings.server : {}),
            },
            websockets: {
                path: "/*",
                maxPayloadLength: 64 * 1024,
                idleTimeout: 240,
                compression: 1,
                maxConnections: 0,
                ...((settings && settings.websockets) ? settings.websockets : {}),
            },
            access: {
                allowOrigins: undefined,
                denyOrigins: undefined,
                denyEmptyOrigin: false,
                ...((settings && settings.access) ? settings.access : {}),
            },
        };

        if (this.settings.websockets.maxConnections !== undefined) {
            this.maxConnections = this.settings.websockets.maxConnections;
        }

        this.validateAccess();

        this._app = this.settings.server.key_file_name === undefined
                ? App(this.settings.server)
                : SSLApp(this.settings.server);

        this.buildApplication();
    }

    public async run() {
        return new Promise<void>((resolve, reject) => {
            this._app.listen(this.settings.server.host, this.settings.server.port, (token: any) => {
                if (token) {
                    resolve();
                } else {
                    reject(new Error(`failed to listen to ${this.settings.server.host}:${this.settings.server.port}`));
                }
            });
        });
    }

    // tslint:disable-next-line:cognitive-complexity
    private validateAccess() {
        if (this.settings.access.allowOrigins !== undefined) {
            if (this.settings.access.denyOrigins !== undefined) {
                throw new Error("allowOrigins and denyOrigins can't be set simultaneously");
            } else if (!(this.settings.access.allowOrigins instanceof Array)) {
                throw new Error("allowOrigins configuration paramenters should be an array of strings");
            }
        } else if ((this.settings.access.denyOrigins !== undefined) && !(this.settings.access.denyOrigins instanceof Array)) {
            throw new Error("denyOrigins configuration paramenters should be an array of strings");
        }

        const origins: string[] | undefined = (this.settings.access.allowOrigins === undefined
            ? this.settings.access.denyOrigins
            : this.settings.access.allowOrigins);

        if (origins !== undefined) {
            for (const origin of origins) {
                if (typeof origin !== "string") {
                    throw new Error("allowOrigins and denyOrigins configuration paramenters should be arrays of strings");
                }
            }
        }

        if (this.settings.access.denyEmptyOrigin || this.settings.access.allowOrigins || this.settings.access.denyOrigins) {
            this.validateOrigin = true;
        }
    }

    private buildApplication() {
        this._app
        .ws(this.settings.websockets.path, {
            compression: this.settings.websockets.compression,
            maxPayloadLength: this.settings.websockets.maxPayloadLength,
            idleTimeout: this.settings.websockets.idleTimeout,
            open: this.onOpen,
            drain: (ws: WebSocket) => {
                if (debugWebSocketsEnabled) {
                    debugWebSockets("drain", ws.getBufferedAmount());
                }
            },
            message: this.onMessage,
            close: this.onClose,
        });
    }

    private onOpen = (ws: WebSocket, request: HttpRequest) => {
        this.webSocketsCount++;

        if ((this.maxConnections !== 0) && (this.webSocketsCount > this.maxConnections)) {
            if (debugRequestsEnabled) {
                debugRequests(this.settings.server.host, this.settings.server.port,
                    "ws-denied-max-connections url:", request.getUrl(), "query:", request.getQuery(),
                    "origin:", request.getHeader("origin"), "total:", this.webSocketsCount);
            }
            ws.close();
            return;
        }

        if (debugWebSocketsEnabled) {
            debugWebSockets("connected via URL", request.getUrl());
        }

        if (this.validateOrigin) {
            const origin = request.getHeader("origin");
            if ((this.settings.access.denyEmptyOrigin && origin.length === 0) ||
                    (this.settings.access.denyOrigins && (this.settings.access.denyOrigins as string[]).includes(origin)) ||
                    (this.settings.access.allowOrigins && !(this.settings.access.allowOrigins as string[]).includes(origin))) {
                if (debugRequestsEnabled) {
                    debugRequests(this.settings.server.host, this.settings.server.port,
                        "ws-denied url:", request.getUrl(), "query:", request.getQuery(),
                        "origin:", origin, "total:", this.webSocketsCount);
                }
                ws.close();
                return;
            }
        }

        if (debugRequestsEnabled) {
            debugRequests(this.settings.server.host, this.settings.server.port,
                "ws-open url:", request.getUrl(), "query:", request.getQuery(),
                "origin:", request.getHeader("origin"), "total:", this.webSocketsCount);
        }
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

        if (ws.sendMessage === undefined) {
            ws.sendMessage = sendMessage;
        }

        if (debugMessagesEnabled) {
            debugMessages("in", ws.id !== undefined ? Buffer.from(ws.id).toString("hex") : "unknown peer", json);
        }

        try {
            this.tracker.processMessage(json, ws as any);
        } catch (e) {
            if (e instanceof TrackerError) {
                debugWebSockets("failed to process message from the peer:", e);
                ws.close();
            } else {
                throw e;
            }
        }
    }

    private onClose = (ws: WebSocket, code: number, message: ArrayBuffer) => {
        this.webSocketsCount--;

        if (ws.sendMessage !== undefined) {
            this.tracker.disconnectPeer(ws as any);
        }

        debugWebSockets("closed with code", code);
    }
}

function sendMessage(json: any, ws: WebSocket) {
    ws.send(JSON.stringify(json), false, false);
    if (debugMessagesEnabled) {
        debugMessages("out", ws.id !== undefined ? Buffer.from(ws.id).toString("hex") : "unknown peer", json);
    }
}
