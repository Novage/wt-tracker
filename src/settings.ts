/**
 * Copyright 2025 Novage LLC.
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

export function validateSettings(
  jsonSettings: UnknownObject,
): Settings | undefined {
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
