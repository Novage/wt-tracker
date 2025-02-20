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

export interface Swarm<ConnectionContext extends Record<string, unknown>> {
  infoHash: string;
  completedPeers?: Set<string>;
  peers: PeerContext<ConnectionContext>[];
}

export interface PeerContext<
  ConnectionContext extends Record<string, unknown>,
> {
  peerId: string;
  connection: ConnectionContext;
  lastAccessed: number;
  swarm: Swarm<ConnectionContext>;
}

export interface Tracker<
  ConnectionContext extends Record<string, PeerContext<ConnectionContext>>,
> {
  readonly swarms: ReadonlyMap<
    string,
    { peers: readonly PeerContext<ConnectionContext>[] }
  >;

  readonly settings: Record<string, unknown>;

  processMessage: (
    json: Record<string, unknown>,
    connection: ConnectionContext,
  ) => void;

  disconnectPeers: (connection: ConnectionContext) => void;
}

export class TrackerError extends Error {}
