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
import { UWebSocketsTracker, UwsConnectionContext } from "./uws-tracker.js";
import { Tracker } from "./tracker.js";
import { Settings } from "./settings.js";
import { buildUwsTracker } from "./build-uws-tracker.js";

export async function runSocketApp(
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
    const server = buildUwsTracker({
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
