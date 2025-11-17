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

import { StringDecoder } from "string_decoder";
import {
  App,
  SSLApp,
  WebSocket,
  HttpRequest,
  TemplatedApp,
  us_socket_context_t,
  HttpResponse,
} from "uWebSockets.js";
import Debug from "debug";
import { Tracker, TrackerError } from "./tracker.js";
import {
  ServerSettings,
  WebSocketsAccessSettings,
  WebSocketsSettings,
} from "./settings.js";
import { threadId } from "node:worker_threads";

const debugSuffix = threadId ? `-${threadId}` : "";

const debugWebSockets = Debug(`wt-tracker:uws-tracker${debugSuffix}`);
const debugWebSocketsEnabled = debugWebSockets.enabled;

const debugMessages = Debug(`wt-tracker:uws-tracker-messages${debugSuffix}`);
const debugMessagesEnabled = debugMessages.enabled;

const debugRequests = Debug(`wt-tracker:uws-tracker-requests${debugSuffix}`);
const debugRequestsEnabled = debugRequests.enabled;

const decoder = new StringDecoder();

export type UwsConnectionContext = {
  ws?: WebSocket<UwsConnectionContext>;
} & Record<string, unknown>;

export interface UwsTrackerSettings {
  server: ServerSettings;
  websockets: WebSocketsSettings;
  access: WebSocketsAccessSettings;
}

export interface PartialUwsTrackerSettings {
  server?: Partial<ServerSettings>;
  websockets?: Partial<WebSocketsSettings>;
  access?: Partial<WebSocketsAccessSettings>;
}

export class UWebSocketsTracker {
  public readonly settings: UwsTrackerSettings;
  public readonly tracker: Readonly<Tracker<UwsConnectionContext>>;

  private webSocketsCount = 0;
  private validateOrigin = false;
  private readonly maxConnections: number;

  readonly #app: TemplatedApp;

  public constructor(
    tracker: Readonly<Tracker<UwsConnectionContext>>,
    settings: PartialUwsTrackerSettings,
  ) {
    this.tracker = tracker;
    this.settings = {
      server: {
        port: 8000,
        host: "0.0.0.0",
        ...settings.server,
      },
      websockets: {
        path: "/*",
        maxPayloadLength: 64 * 1024,
        idleTimeout: 240,
        compression: 1,
        maxConnections: 0,
        ...settings.websockets,
      },
      access: {
        allowOrigins: undefined,
        denyOrigins: undefined,
        denyEmptyOrigin: false,
        ...settings.access,
      },
    };

    this.maxConnections = this.settings.websockets.maxConnections;

    this.validateAccess();

    this.#app =
      this.settings.server.key_file_name === undefined
        ? App(this.settings.server)
        : SSLApp(this.settings.server);

    this.buildApplication();
  }

  public get app(): TemplatedApp {
    return this.#app;
  }

  public get stats() {
    return {
      threadId,
      webSocketsCount: this.webSocketsCount,
    };
  }

  public async run(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#app.listen(
        this.settings.server.host,
        this.settings.server.port,
        (token: false | object) => {
          if (token === false) {
            reject(
              new Error(
                `failed to listen to ${this.settings.server.host}:${this.settings.server.port}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
  }

  private validateAccess(): void {
    if (this.settings.access.allowOrigins !== undefined) {
      if (this.settings.access.denyOrigins !== undefined) {
        throw new Error(
          "allowOrigins and denyOrigins can't be set simultaneously",
        );
      } else if (!(this.settings.access.allowOrigins instanceof Array)) {
        throw new Error(
          "allowOrigins configuration paramenters should be an array of strings",
        );
      }
    } else if (
      this.settings.access.denyOrigins !== undefined &&
      !(this.settings.access.denyOrigins instanceof Array)
    ) {
      throw new Error(
        "denyOrigins configuration paramenters should be an array of strings",
      );
    }

    const origins: readonly string[] | undefined =
      this.settings.access.allowOrigins ?? this.settings.access.denyOrigins;

    if (origins !== undefined) {
      for (const origin of origins) {
        if (typeof origin !== "string") {
          throw new Error(
            "allowOrigins and denyOrigins configuration paramenters should be arrays of strings",
          );
        }
      }
    }

    this.validateOrigin =
      this.settings.access.denyEmptyOrigin ||
      this.settings.access.allowOrigins !== undefined ||
      this.settings.access.denyOrigins !== undefined;
  }

  private buildApplication(): void {
    this.#app.ws(this.settings.websockets.path, {
      compression: this.settings.websockets.compression,
      maxPayloadLength: this.settings.websockets.maxPayloadLength,
      idleTimeout: this.settings.websockets.idleTimeout,
      open: this.onOpen,
      upgrade: this.onUpgrade,
      drain: (ws: WebSocket<UwsConnectionContext>) => {
        if (debugWebSocketsEnabled) {
          debugWebSockets("drain", ws.getBufferedAmount());
        }
      },
      message: this.onMessage,
      close: this.onClose,
    });
  }

  private readonly onOpen = (ws: WebSocket<UwsConnectionContext>): void => {
    const userData = ws.getUserData();
    userData.ws = ws;

    this.webSocketsCount++;
  };

  private readonly onUpgrade = (
    response: HttpResponse,
    request: HttpRequest,
    context: us_socket_context_t,
  ): void => {
    if (
      this.maxConnections !== 0 &&
      this.webSocketsCount > this.maxConnections
    ) {
      if (debugRequestsEnabled) {
        debugRequests(
          this.settings.server.host,
          this.settings.server.port,
          "ws-denied-max-connections url:",
          request.getUrl(),
          "query:",
          request.getQuery(),
          "origin:",
          request.getHeader("origin"),
          "total:",
          this.webSocketsCount,
        );
      }

      response.close();
      return;
    }

    if (debugWebSocketsEnabled) {
      debugWebSockets("connected via URL", request.getUrl());
    }

    if (this.validateOrigin) {
      const origin = request.getHeader("origin");

      const shouldDeny =
        (this.settings.access.denyEmptyOrigin && origin.length === 0) ||
        this.settings.access.denyOrigins?.includes(origin) === true ||
        this.settings.access.allowOrigins?.includes(origin) === false;

      if (shouldDeny) {
        if (debugRequestsEnabled) {
          debugRequests(
            this.settings.server.host,
            this.settings.server.port,
            "ws-denied url:",
            request.getUrl(),
            "query:",
            request.getQuery(),
            "origin:",
            origin,
            "total:",
            this.webSocketsCount,
          );
        }

        response.close();
        return;
      }
    }

    if (debugRequestsEnabled) {
      debugRequests(
        this.settings.server.host,
        this.settings.server.port,
        "ws-open url:",
        request.getUrl(),
        "query:",
        request.getQuery(),
        "origin:",
        request.getHeader("origin"),
        "total:",
        this.webSocketsCount,
      );
    }

    response.upgrade(
      {},
      request.getHeader("sec-websocket-key"),
      request.getHeader("sec-websocket-protocol"),
      request.getHeader("sec-websocket-extensions"),
      context,
    );
  };

  private readonly onMessage = (
    ws: WebSocket<UwsConnectionContext>,
    message: ArrayBuffer,
  ): void => {
    debugWebSockets("message of size", message.byteLength);

    let json;
    try {
      json = JSON.parse(
        decoder.end(new Uint8Array(message) as Buffer),
      ) as Record<string, unknown>;
    } catch (e) {
      debugWebSockets("failed to parse JSON message", e);
      ws.close();
      return;
    }

    if (debugMessagesEnabled) {
      debugMessages("in", json);
    }

    try {
      const userData = ws.getUserData();
      this.tracker.processMessage(json, userData);
    } catch (e) {
      if (e instanceof TrackerError) {
        debugWebSockets("failed to process message from the peer:", e);
        ws.close();
      } else {
        throw e;
      }
    }
  };

  private readonly onClose = (
    ws: WebSocket<UwsConnectionContext>,
    code: number,
  ): void => {
    this.webSocketsCount--;

    const userData = ws.getUserData() as
      | ReturnType<typeof ws.getUserData>
      | undefined;

    // Test that user data is really a connection context
    if (userData?.ws) {
      this.tracker.disconnect(userData);
    }

    debugWebSockets("closed with code", code);
  };
}

export function sendMessage(json: object, connection: UwsConnectionContext) {
  // Connection without WebSocket is not possible here
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  connection.ws!.send(JSON.stringify(json), false, false);
  if (debugMessagesEnabled) {
    debugMessages("out", json);
  }
}
