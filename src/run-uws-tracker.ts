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

/* eslint-disable no-console */

import { readFileSync } from "fs";
import { HttpResponse, HttpRequest } from "uWebSockets.js";
import {
  sendMessage,
  UWebSocketsTracker,
  UwsConnectionContext,
} from "./uws-tracker.js";
import { FastTracker } from "./fast-tracker.js";
import { Tracker } from "./tracker.js";
import { debugRequest } from "./debugRequest.js";
import {
  ServerItemSettings,
  Settings,
  validateSettings,
  WebSocketsAccessSettings,
} from "./settings.js";

async function main(): Promise<void> {
  let settingsFileData: Buffer | undefined = undefined;

  if (process.argv.length <= 2) {
    try {
      settingsFileData = readFileSync("config.json");
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") {
        console.error("failed to read configuration file:", e);
        return;
      }
    }
  } else {
    try {
      settingsFileData = readFileSync(process.argv[2]);
    } catch (e) {
      console.error("failed to read configuration file:", e);
      return;
    }
  }

  let jsonSettings: Record<string, unknown> | undefined = undefined;

  try {
    jsonSettings =
      settingsFileData === undefined
        ? {}
        : (JSON.parse(settingsFileData.toString()) as Record<string, unknown>);
  } catch (e) {
    console.error("failed to parse JSON configuration file:", e);
    return;
  }

  const settings = validateSettings(jsonSettings);
  if (settings === undefined) {
    return;
  }

  const tracker = new FastTracker(settings.tracker, sendMessage);

  try {
    await runServers(tracker, settings);
  } catch (e) {
    console.error("failed to start the web server:", e);
  }
}

async function runServers(
  tracker: Tracker<UwsConnectionContext>,
  settings: Settings,
): Promise<void> {
  let indexHtml: Buffer | undefined = undefined;

  try {
    indexHtml = readFileSync("index.html");
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      throw e;
    }
  }

  const servers: UWebSocketsTracker[] = [];

  const serverPromises = settings.servers.map(async (serverSettings) => {
    const server = buildServer({
      tracker,
      serverSettings,
      websocketsAccess: settings.websocketsAccess,
      indexHtml,
      servers,
    });
    servers.push(server);
    await server.run();
    console.info(
      `listening ${server.settings.server.host}:${server.settings.server.port}`,
    );
  });

  await Promise.all(serverPromises);
}

type BuildServerParams = {
  tracker: Tracker<UwsConnectionContext>;
  serverSettings: ServerItemSettings;
  websocketsAccess: Partial<WebSocketsAccessSettings> | undefined;
  indexHtml: Buffer | undefined;
  servers: UWebSocketsTracker[];
};

function buildServer({
  tracker,
  serverSettings,
  websocketsAccess,
  indexHtml,
  servers,
}: BuildServerParams): UWebSocketsTracker {
  if (!(serverSettings instanceof Object)) {
    throw Error(
      "failed to parse JSON configuration file: 'servers' property should be an array of objects",
    );
  }

  const server = new UWebSocketsTracker(tracker, {
    ...serverSettings,
    access: websocketsAccess,
  });

  server.app
    .get("/", (response: HttpResponse, request: HttpRequest) => {
      debugRequest(server, request);

      if (indexHtml === undefined) {
        const status = "404 Not Found";
        response.writeStatus(status).end(status);
      } else {
        response.end(indexHtml);
      }
    })
    .get("/stats.json", (response: HttpResponse, request: HttpRequest) => {
      debugRequest(server, request);

      const { swarms } = tracker;
      const peersCountPerInfoHash: Record<string, number> = {};

      let peersCount = 0;
      for (const [infoHash, swarm] of swarms) {
        peersCount += swarm.peers.length;

        const infoHashHex = Buffer.from(infoHash, "binary").toString("hex");
        peersCountPerInfoHash[infoHashHex] = swarm.peers.length;
      }

      const serversStats = [];
      for (const serverForStats of servers) {
        const { settings } = serverForStats;
        serversStats.push({
          server: `${settings.server.host}:${settings.server.port}`,
          webSocketsCount: serverForStats.stats.webSocketsCount,
        });
      }

      response.writeHeader("Content-Type", "application/json").end(
        JSON.stringify({
          torrentsCount: swarms.size,
          peersCount,
          servers: serversStats,
          memory: process.memoryUsage(),
          peersCountPerInfoHash,
        }),
      );
    })
    .any("/*", (response: HttpResponse, request: HttpRequest) => {
      debugRequest(server, request);

      const status = "404 Not Found";
      response.writeStatus(status).end(status);
    });

  return server;
}

try {
  await main();
} catch (e) {
  console.error(e);
}
