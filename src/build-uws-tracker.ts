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
  servers: UWebSocketsTracker[];
};

export function buildUwsTracker({
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
