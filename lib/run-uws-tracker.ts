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

// tslint:disable:no-console

async function main() {
    let settingsFileData;

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

    let settings;
    try {
        settings = (settingsFileData !== undefined) ? JSON.parse(settingsFileData.toString()) : {};
    } catch (e) {
        console.error("failed to parse JSON configuration file:", e.toString());
        return;
    }

    const tracker = new FastTracker(settings.tracker);

    try {
        const server = new UWebSocketsTracker(tracker, settings);

        server.app
        .get("/stats.json", (response: HttpResponse, request: HttpRequest) => {
            const swarms = tracker.swarms;
            let peersCount = 0;
            for (const swarm of swarms.values()) {
                peersCount += swarm.peers.size;
            }

            response.writeHeader("Content-Type", "application/json")
            .end(JSON.stringify({
                torrentsCount: swarms.size,
                peersCount: peersCount,
                ...server.stats,
            }));
        })
        .get("/*", (response: HttpResponse, request: HttpRequest) => {
            const status = "404 Not Found";
            response.writeStatus(status).end(status);
        });

        await server.run();
        console.info(`listening ${server.settings.server.host}:${server.settings.server.port}`);
    } catch (e) {
        console.error("failed to start the web server:", e.toString());
    }
}

(async () => {
    try {
        await main();
    } catch (e) {
        console.error(e);
    }
})();
