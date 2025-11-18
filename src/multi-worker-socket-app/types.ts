import type { Settings } from "../settings.ts";
import { MessagePort } from "node:worker_threads";

export type WorkerDataType = {
  settings: Settings;
  trackerPorts: MessagePort[];
};

export type AppDescriptorMessage = {
  workerAppDescriptor: unknown;
  appIndex: number;
  type: "appDescriptor";
};

export type AppStatsResponse = {
  id: number;
  type: "appStats";
  stats: {
    threadId: number;
    webSocketsCount: number;
  };
};

export type AppsStatsResponse = {
  id: number;
  type: "appsStats";
  stats: AppStatsResponse["stats"][];
};

export type AppStatsRequest = {
  id: number;
  type: "getAppStats";
};

export type AppsStatsRequest = {
  id: number;
  type: "getAppsStats";
};

export type ServerWorkerOutMessage =
  | AppDescriptorMessage
  | AppStatsResponse
  | AppsStatsRequest;

export type ServerWorkerInMessage = AppStatsRequest | AppsStatsResponse;
