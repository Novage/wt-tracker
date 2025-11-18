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

import Debug from "debug";
import { UWebSocketsTracker } from "./uws-tracker.ts";
import type { HttpRequest } from "uWebSockets.js";

const debugRequests = Debug("wt-tracker:uws-tracker-requests");
const debugRequestsEnabled = debugRequests.enabled;

export function debugRequest(
  server: UWebSocketsTracker,
  request: HttpRequest,
): void {
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
