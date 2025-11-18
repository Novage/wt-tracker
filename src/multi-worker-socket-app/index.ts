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

import { App, SSLApp } from "uWebSockets.js";
import type { Settings } from "../settings.ts";
import { Worker } from "node:worker_threads";
import type {
  AppsStatsResponse,
  ServerWorkerInMessage,
  ServerWorkerOutMessage,
  WorkerDataType,
} from "./types.ts";
import { MultiWorkerTracker } from "../multi-worker-tracker/index.ts";

export async function runSocketWorkersApp(settings: Settings) {
  // Create connections acceptors

  const acceptorAppPromises = settings.servers.map(async (serverSettings) => {
    if (!(serverSettings instanceof Object)) {
      throw Error(
        "failed to parse JSON configuration file: 'servers' property should be an array of objects",
      );
    }

    const appSettings = {
      port: 8000,
      host: "0.0.0.0",
      ...serverSettings.server,
    };

    const app =
      appSettings.key_file_name === undefined
        ? App(appSettings)
        : SSLApp(appSettings);

    await new Promise<void>((resolve, reject) => {
      app.listen(
        appSettings.host,
        appSettings.port,
        (token: false | object) => {
          if (token === false) {
            reject(
              new Error(
                `failed to listen to ${appSettings.host}:${appSettings.port}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });

    return app;
  });

  const acceptorApps = await Promise.all(acceptorAppPromises);

  // Create tracker workers

  const { buildWorkerPorts } = MultiWorkerTracker.buildWorkers(
    settings.tracker,
  );

  // Create socket workers

  const socketWorkers: Worker[] = [];

  // TODO: number of workers configurable

  const moduleExtension = import.meta.filename.endsWith(".js") ? "js" : "ts";

  for (let workerIndex = 0; workerIndex < 4; workerIndex++) {
    // Ports between the socket worker and the tracker workers
    const trackerPorts = buildWorkerPorts();

    const worker = new Worker(
      `${import.meta.dirname}/worker.${moduleExtension}`,
      {
        workerData: {
          settings,
          trackerPorts,
        } satisfies WorkerDataType,
        transferList: trackerPorts,
      },
    );

    socketWorkers.push(worker);

    // Bind acceptors and socket workers

    worker.on("message", (message: ServerWorkerOutMessage) => {
      if (message.type === "appDescriptor") {
        (
          acceptorApps[message.appIndex] as unknown as {
            addChildAppDescriptor: (descriptor: unknown) => void;
          }
        ).addChildAppDescriptor(message.workerAppDescriptor);
      } else if (message.type === "getAppsStats") {
        const requestAppsStats = async () => {
          const requestId = Math.random();
          const appsStats: AppsStatsResponse["stats"] = [];

          for (const worker of socketWorkers) {
            const appStats = await new Promise<(typeof appsStats)[number]>(
              (resolve) => {
                const listener = (message: ServerWorkerOutMessage) => {
                  if (message.type === "appStats" && message.id === requestId) {
                    resolve(message.stats);
                    worker.removeListener("message", listener);
                  }
                };

                worker.addListener("message", listener);
                worker.postMessage({
                  type: "getAppStats",
                  id: requestId,
                } satisfies ServerWorkerInMessage);
              },
            );

            appsStats.push(appStats);
          }

          worker.postMessage({
            type: "appsStats",
            id: message.id,
            stats: appsStats,
          } satisfies ServerWorkerInMessage);
        };

        void requestAppsStats();
      }
    });
  }
}
