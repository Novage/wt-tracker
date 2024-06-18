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

import { WebSocket } from "uWebSockets.js";

export interface SocketContext {
  sendMessage: (json: object, peer: SocketContext) => void;
  peerIdsOnSocket: Set<string>;
}

export interface PeerContext {
  id: string;
  sendMessage: (json: object, peer: SocketContext) => void;
  ws: WebSocket<SocketContext>;
}

export interface Tracker {
  readonly swarms: ReadonlyMap<string, { peers: readonly PeerContext[] }>;
  readonly settings: object;
  processMessage: (json: object, peer: SocketContext) => void;
  disconnectPeer: (peer: SocketContext) => void;
}

export class TrackerError extends Error {}
