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
import { validateSettings } from "./settings.js";
import { runSocketWorkersApp } from "./multi-worker-socket-app/index.js";

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

  try {
    await runSocketWorkersApp(settings);
  } catch (e) {
    console.error("failed to start the web server:", e);
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
}
