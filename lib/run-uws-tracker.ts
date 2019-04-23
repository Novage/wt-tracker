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

import { UWebSocketsTracker } from "./uws-tracker";
import { FastTracker } from "./fast-tracker";
import { readFileSync } from "fs";
import { HttpResponse, HttpRequest } from "uWebSockets.js";
import { Tracker } from "./tracker";
import * as Debug from "debug";

const debugRequests = Debug("wt-tracker:uws-tracker-requests");
const debugRequestsEnabled = debugRequests.enabled;

// tslint:disable:no-console

async function main() {
    let settingsFileData: any;

    if (process.argv[2]) {
        try {
            settingsFileData = readFileSync(process.argv[2]);
        } catch (e) {
            console.error("failed to read configuration file:", e.toString());
            return;
        }
    } else {
        try {
            settingsFileData = readFileSync("config.json");
        } catch (e) {
            if (e.code !== "ENOENT") {
                console.error("failed to read configuration file:", e.toString());
                return;
            }
        }
    }

    let settings: any;
    try {
        settings = (settingsFileData !== undefined) ? JSON.parse(settingsFileData.toString()) : {};
    } catch (e) {
        console.error("failed to parse JSON configuration file:", e.toString());
        return;
    }

    const serversSettings = (settings.servers === undefined ? [{}] : settings.servers);

    if (!(serversSettings instanceof Array)) {
        console.error("failed to parse JSON configuration file: 'servers' property should be an array");
        return;
    }

    const tracker = new FastTracker(settings.tracker);

    try {
        await runServers(serversSettings, tracker, settings.websocketsAccess);
    } catch (e) {
        console.error("failed to start the web server:", e.toString());
    }
}

async function runServers(serversSettings: any[], tracker: Tracker, websocketsAccess: any) {
    const servers: UWebSocketsTracker[] = [];
    let indexHtml: Buffer | undefined;
    try {
        indexHtml = readFileSync("index.html");
    } catch (e) {
        if (e.code !== "ENOENT") {
            throw e;
        }
    }

    for (const serverSettings of serversSettings) {
        serverSettings.access = websocketsAccess;
        const server = new UWebSocketsTracker(tracker, serverSettings);

        server.app
        .get("/", (response: HttpResponse, request: HttpRequest) => {
            debugRequest(server, request);

            if (indexHtml !== undefined) {
                response.end(indexHtml);
            } else {
                const status = "404 Not Found";
                response.writeStatus(status).end(status);
            }
        })
        .get("/stats.json", (response: HttpResponse, request: HttpRequest) => {
            debugRequest(server, request);

            const swarms = tracker.swarms;
            let peersCount = 0;
            for (const swarm of swarms.values()) {
                peersCount += swarm.peers.length;
            }

            const serversStats = new Array<{ server: string, webSocketsCount: number }>();
            for (const serverForStats of servers) {
                const settings = serverForStats.settings;
                serversStats.push({
                    server: `${settings.server.host}:${settings.server.port}`,
                    webSocketsCount: serverForStats.stats.webSocketsCount,
                });
            }

            response.writeHeader("Content-Type", "application/json")
            .end(JSON.stringify({
                torrentsCount: swarms.size,
                peersCount: peersCount,
                servers: serversStats,
                memory: process.memoryUsage(),
            }));
        })
        .any("/*", (response: HttpResponse, request: HttpRequest) => {
            debugRequest(server, request);

            const status = "404 Not Found";
            response.writeStatus(status).end(status);
        });

        servers.push(server);
        await server.run();
        console.info(`listening ${server.settings.server.host}:${server.settings.server.port}`);
    }
}

function debugRequest(server: UWebSocketsTracker, request: HttpRequest) {
    if (debugRequestsEnabled) {
        debugRequests(server.settings.server.host, server.settings.server.port,
            "request method:", request.getMethod(), "url:", request.getUrl(),
            "query:", request.getQuery());
    }
}

(async () => {
    try {
        await main();
    } catch (e) {
        console.error(e);
    }
})();
