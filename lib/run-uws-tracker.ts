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

let settingsFileData = undefined;

if (process.argv[2]) {
    settingsFileData = readFileSync(process.argv[2]);
} else {
    try {
        settingsFileData = readFileSync("config.json");
    } catch (e) {
        if (e.code !== "ENOENT") {
            throw e;
        }
    }
}

const settings = (settingsFileData !== undefined)
    ? JSON.parse(settingsFileData.toString("utf8"))
    : {};

const tracker = new FastTracker(settings.tracker);

try {
    const server = new UWebSocketsTracker(tracker, settings);

    server.app
    .get("/stats.json", (response: any, request: any) => {
        response.writeHeader("Content-Type", "application/json")
        .end(JSON.stringify({
            ...tracker.stats,
            ...server.stats
        }));
    })
    .get("/*", (response: any, request: any) => {
        const status = "404 Not Found";
        response.writeStatus(status).end(status);
    });

    server.run();
} catch (e) {
    console.error("failed to start Web server: ", e);
}
