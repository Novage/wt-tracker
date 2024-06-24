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
import Debug from "debug";
import { UWebSocketsTracker } from "./uws-tracker.js";
import { FastTracker } from "./fast-tracker.js";
import { Tracker } from "./tracker.js";

const debugRequests = Debug("wt-tracker:uws-tracker-requests");
const debugRequestsEnabled = debugRequests.enabled;

interface BuildServerParams {
  tracker: Tracker;
  serverSettings: ServerItemSettings;
  websocketsAccess: Partial<WebSocketsAccessSettings> | undefined;
  indexHtml: Buffer | undefined;
  servers: UWebSocketsTracker[];
}

type UnknownObject = Record<string, unknown>;

export interface Settings {
  servers: ServerItemSettings[];
  tracker?: object;
  websocketsAccess?: Partial<WebSocketsAccessSettings>;
}

export interface ServerItemSettings {
  server?: Partial<ServerSettings>;
  websockets?: Partial<WebSocketsSettings>;
}

export interface ServerSettings {
  port: number;
  host: string;
  key_file_name?: string;
  cert_file_name?: string;
  passphrase?: string;
  dh_params_file_name?: string;
  ssl_prefer_low_memory_usage?: boolean;
}

export interface WebSocketsSettings {
  path: string;
  maxPayloadLength: number;
  idleTimeout: number;
  compression: number;
  maxConnections: number;
}

export interface WebSocketsAccessSettings {
  allowOrigins?: readonly string[];
  denyOrigins?: readonly string[];
  denyEmptyOrigin: boolean;
}

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

  let jsonSettings: UnknownObject | undefined = undefined;

  try {
    jsonSettings =
      settingsFileData === undefined
        ? {}
        : (JSON.parse(settingsFileData.toString()) as UnknownObject);
  } catch (e) {
    console.error("failed to parse JSON configuration file:", e);
    return;
  }

  const settings = validateSettings(jsonSettings);
  if (settings === undefined) {
    return;
  }

  const tracker = new FastTracker(settings.tracker);

  try {
    await runServers(tracker, settings);
  } catch (e) {
    console.error("failed to start the web server:", e);
  }
}

function validateSettings(jsonSettings: UnknownObject): Settings | undefined {
  if (
    jsonSettings.servers !== undefined &&
    !(jsonSettings.servers instanceof Array)
  ) {
    console.error(
      "failed to parse JSON configuration file: 'servers' property should be an array",
    );
    return undefined;
  }

  const servers: object[] = [];

  if (jsonSettings.servers === undefined) {
    servers.push({});
  } else {
    for (const serverSettings of jsonSettings.servers) {
      if (serverSettings instanceof Object) {
        servers.push(serverSettings as object);
      } else {
        console.error(
          "failed to parse JSON configuration file: 'servers' property should be an array of objects",
        );
        return undefined;
      }
    }
  }

  if (
    jsonSettings.tracker !== undefined &&
    !(jsonSettings.tracker instanceof Object)
  ) {
    console.error(
      "failed to parse JSON configuration file: 'tracker' property should be an object",
    );
    return undefined;
  }

  if (
    jsonSettings.websocketsAccess !== undefined &&
    !(jsonSettings.websocketsAccess instanceof Object)
  ) {
    console.error(
      "failed to parse JSON configuration file: 'websocketsAccess' property should be an object",
    );
    return undefined;
  }

  return {
    servers,
    tracker: jsonSettings.tracker,
    websocketsAccess: jsonSettings.websocketsAccess,
  };
}

async function runServers(tracker: Tracker, settings: Settings): Promise<void> {
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

      const swarms = tracker.swarms;
      const peersCountPerInfoHash: Record<string, number> = {};

      let peersCount = 0;
      for (const [infoHash, swarm] of swarms) {
        peersCount += swarm.peers.length;

        const infoHashHex = Buffer.from(infoHash, "binary").toString("hex");
        peersCountPerInfoHash[infoHashHex] = swarm.peers.length;
      }

      const serversStats = new Array<{
        server: string;
        webSocketsCount: number;
      }>();
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

function debugRequest(server: UWebSocketsTracker, request: HttpRequest): void {
  if (debugRequestsEnabled) {
    debugRequests(
      server.settings.server.host,
      server.settings.server.port,
      "request method:",
      request.getMethod(),
      "url:",
      request.getUrl(),
      "query:",
      request.getQuery(),
    );
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (e) {
    console.error(e);
  }
}

await run();
