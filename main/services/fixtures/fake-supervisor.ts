// fake-supervisor.ts — the relay supervisor the video service attaches to, for
// every test that attaches a relay: "running" with no version unless told otherwise.

import { EventEmitter } from "node:events";

import type { SupervisorStatus } from "../video/supervisor.js";
import type { RelaySupervisorLike } from "../video/video-service.js";

export class FakeSupervisor extends EventEmitter implements RelaySupervisorLike {
  current: SupervisorStatus = { state: "running", since: 1 };
  ver: string | null = null;
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return this.ver;
  }
}
