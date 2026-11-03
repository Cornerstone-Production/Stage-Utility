// Every source, in the order the table in docs/features/operator-app.md gives
// them. That order is the second sort key on Home: critical before warn, then
// by source, then by subject.

import type { AttentionSource } from "../types";
import { integrationDown } from "./integration-down";
import { readiness } from "./readiness";
import { recorderIdle } from "./recorder-idle";
import { screenOffline } from "./screen-offline";
import { wirelessBattery } from "./wireless-battery";
import { wirelessOffline } from "./wireless-offline";

export const ATTENTION_SOURCES: readonly AttentionSource[] = [
  readiness,
  wirelessBattery,
  wirelessOffline,
  screenOffline,
  recorderIdle,
  integrationDown,
];
