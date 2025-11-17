import { FastTrackerSettings } from "../fast-tracker.js";
import { MessagePort } from "node:worker_threads";

export type WorkerDataType = {
  settings?: Partial<FastTrackerSettings>;
};

export type TrackerWorkerInEvent =
  // Pot from socket worker to tracker worker
  | {
      type: "port";
      port: MessagePort;
    }
  // Stats request
  | {
      type: "getStats";
      id: number;
    }
  // Port from socket worker peer to tracker worker peer
  | {
      type: "newPeer";
      port: MessagePort;
    };

export type SwarmsStats = { infoHash: string; peersCount: number }[];

export type TrackerWorkerOutEvent = {
  type: "stats";
  id: number;
  threadId: number;
  swarms: SwarmsStats;
};
