import type { Settings } from "../settings.ts";
import type { Tracker } from "../tracker.ts";
import { sendMessage, UWebSocketsTracker } from "../uws-tracker.ts";
import type { UwsConnectionContext } from "../uws-tracker.ts";
import { readFileSync } from "fs";
import { MessagePort } from "worker_threads";
import {
  isMainThread,
  workerData,
  parentPort,
  threadId,
} from "node:worker_threads";
import { MultiWorkerTracker } from "../multi-worker-tracker/index.ts";
import { buildUwsTracker } from "../build-uws-tracker.ts";
import type {
  AppDescriptorMessage,
  AppsStatsResponse,
  ServerWorkerInMessage,
  ServerWorkerOutMessage,
  WorkerDataType,
} from "./types.ts";

// TODO:
// - test what host and port workers require
// - handle socket bind errors here
// - configure worker ports

if (!isMainThread && parentPort) {
  const { settings, trackerPorts } = workerData as WorkerDataType;

  const tracker = new MultiWorkerTracker(trackerPorts, sendMessage);

  await runSocketApp(tracker, settings, parentPort);
}

async function runSocketApp(
  tracker: Tracker<UwsConnectionContext>,
  settings: Settings,
  parentPort: MessagePort,
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

  const getAppsStats = async () => {
    return new Promise<AppsStatsResponse["stats"]>((resolve) => {
      const id = Math.random();

      const listener = (message: ServerWorkerInMessage) => {
        if (message.type === "appsStats" && message.id === id) {
          resolve(message.stats);
          parentPort.removeListener("message", listener);
        }
      };

      parentPort.addListener("message", listener);

      parentPort.postMessage({
        id,
        type: "getAppsStats",
      } satisfies ServerWorkerOutMessage);
    });
  };

  const serverPromises = settings.servers.map(
    async (serverSettings, appIndex) => {
      const server = buildUwsTracker({
        tracker,
        serverSettings: {
          server: {
            ...serverSettings.server,
            port: (serverSettings.server?.port ?? 8000) + 10000,
          },
          ...serverSettings,
        },
        websocketsAccess: settings.websocketsAccess,
        indexHtml,
        getServersStats: getAppsStats,
      });
      servers.push(server);
      await server.run();

      // The worker sends back its descriptor to the main acceptor
      parentPort.postMessage({
        type: "appDescriptor",
        appIndex,
        workerAppDescriptor: (
          server.app as unknown as { getDescriptor: () => unknown }
        ).getDescriptor(),
      } satisfies AppDescriptorMessage);
    },
  );

  parentPort.on("message", (message: ServerWorkerInMessage) => {
    if (message.type === "getAppStats") {
      parentPort.postMessage({
        type: "appStats",
        id: message.id,
        stats: servers.reduce(
          (acc, server) => {
            return {
              threadId,
              webSocketsCount:
                acc.webSocketsCount + server.stats.webSocketsCount,
            };
          },
          {
            threadId,
            webSocketsCount: 0,
          },
        ),
      } satisfies ServerWorkerOutMessage);
    }
  });

  await Promise.all(serverPromises);
}
