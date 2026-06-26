import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { StageService } from "./gen/stage/v1/stage_pb.js";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8080";

const transport = createConnectTransport({
  baseUrl,
  useBinaryFormat: false,
});

export const stageClient: Client<typeof StageService> = createClient(
  StageService,
  transport,
);
