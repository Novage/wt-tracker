import { HttpRequest, HttpResponse } from "uWebSockets.js";
import { debugRequest } from "./debugRequest.js";
import { ServerItemSettings, WebSocketsAccessSettings } from "./settings.js";
import { Tracker } from "./tracker.js";
import { UWebSocketsTracker, UwsConnectionContext } from "./uws-tracker.js";

type BuildServerParams = {
  tracker: Tracker<UwsConnectionContext>;
  serverSettings: ServerItemSettings;
  websocketsAccess: Partial<WebSocketsAccessSettings> | undefined;
  indexHtml: Buffer | undefined;
  getServersStats: () => Promise<unknown>;
};

export function buildUwsTracker({
  tracker,
  serverSettings,
  websocketsAccess,
  indexHtml,
  getServersStats,
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
    .get(
      "/stats.json",
      async (response: HttpResponse, request: HttpRequest) => {
        debugRequest(server, request);

        response.onAborted(() => {
          response.aborted = true;
        });

        const swarms = await tracker.getSwarms();
        const serversStats = await getServersStats();

        if (!response.aborted) {
          const peersCountPerInfoHashPerTracker: Record<string, number>[] = [];
          let peersCount = 0;
          let torrentsCount = 0;

          for (const trackerSwarms of swarms) {
            const peersCountPerInfoHash: Record<string, number> = {
              totalPeers: 0,
            };

            for (const swarm of trackerSwarms) {
              peersCount += swarm.peersCount;
              torrentsCount++;

              const infoHashHex = Buffer.from(
                swarm.infoHash,
                "binary",
              ).toString("hex");

              peersCountPerInfoHash[infoHashHex] = swarm.peersCount;
              peersCountPerInfoHash.totalPeers += swarm.peersCount;
            }

            peersCountPerInfoHashPerTracker.push(peersCountPerInfoHash);
          }

          response.cork(() => {
            response.writeHeader("Content-Type", "application/json").end(
              JSON.stringify({
                torrentsCount,
                peersCount,
                servers: serversStats,
                memory: process.memoryUsage(),
                peersCountPerInfoHashPerTracker,
              }),
            );
          });
        }
      },
    )
    .any("/*", (response: HttpResponse, request: HttpRequest) => {
      debugRequest(server, request);

      const status = "404 Not Found";
      response.writeStatus(status).end(status);
    });

  return server;
}
