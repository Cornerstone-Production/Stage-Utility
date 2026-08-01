// ProviderRegistry — registers DeviceProvider implementations and exposes
// their descriptors to the UI (via IntegrationManager / wireless handler).

import type { DeviceProvider } from "../types/devices.js";
import type { ConfigField, IntegrationDescriptor } from "../types/integrations.js";
import { NoneProvider } from "./wireless/none-provider.js";
import { SennheiserEwG4 } from "./wireless/sennheiser-ewg4.js";
import { SennheiserEwDx } from "./wireless/sennheiser-ewdx.js";
import { SennheiserSpectera } from "./wireless/sennheiser-spectera.js";
import { ShureAxient } from "./wireless/shure-axient.js";
import { ShureCharger } from "./wireless/shure-charger.js";
import { ShurePsm } from "./wireless/shure-psm.js";
import { ShureUlxd } from "./wireless/shure-ulxd.js";

// Common host/port/channels fields shared across Shure providers.
function shureFields(channelsPlaceholder: string): ConfigField[] {
  return [
    { key: "host", label: "Device IP / Hostname", type: "text", placeholder: "192.168.1.100" },
    { key: "port", label: "TCP Port", type: "number", placeholder: "2202" },
    { key: "channels", label: "Number of Channels", type: "number", placeholder: channelsPlaceholder },
  ];
}

// Provider ids that have a real driver implementation.
const DRIVER_IDS = new Set<string>(["none", "shure-ulxd", "shure-axient", "shure-psm", "shure-charger", "sennheiser-ewg4", "sennheiser-ewdx", "sennheiser-spectera"]);

// All provider descriptors — shown in the UI dropdown.
const PROVIDER_DESCRIPTORS = new Map<string, IntegrationDescriptor>([
  [
    "none",
    { id: "none", kind: "wireless", label: "None", configSchema: [] },
  ],
  [
    "shure-axient",
    {
      id: "shure-axient",
      kind: "wireless",
      label: "Shure Axient Digital",
      configSchema: shureFields("4"),
    },
  ],
  [
    "shure-psm",
    {
      id: "shure-psm",
      kind: "wireless",
      label: "Shure PSM (In-Ear)",
      configSchema: shureFields("2"),
    },
  ],
  [
    "shure-ulxd",
    {
      id: "shure-ulxd",
      kind: "wireless",
      label: "Shure ULX-D",
      configSchema: shureFields("4"),
    },
  ],
  [
    "shure-charger",
    {
      id: "shure-charger",
      kind: "wireless",
      label: "Shure SBC Charger",
      configSchema: shureFields("2"),
    },
  ],
  [
    "sennheiser-ewg4",
    {
      id: "sennheiser-ewg4",
      kind: "wireless",
      label: "Sennheiser ewG4 (SSC)",
      description:
        "Reads RF and battery telemetry from ewG4 receivers over Sennheiser SSC (Sound Control), UDP port 45. Best-effort and hardware-unverified — validate against your gear, and set SENNHEISER_DEBUG=1 to log raw frames if values read blank.",
      configSchema: [
        { key: "host", label: "Device IP / Hostname", type: "text", placeholder: "192.168.1.120" },
        { key: "port", label: "SSC Port", type: "number", placeholder: "45" },
        { key: "channels", label: "Number of Channels", type: "number", placeholder: "2" },
      ],
    },
  ],
  [
    "sennheiser-ewdx",
    {
      id: "sennheiser-ewdx",
      kind: "wireless",
      label: "Sennheiser EW-DX",
      description:
        "Reads RF and battery telemetry from an EW-DX receiver (EM2/EM4) or CHG 70N charger over Sennheiser SSC, UDP port 45. The model you pick sets how many channels or charging bays appear and how telemetry is read.",
      configSchema: [
        { key: "host", label: "Device IP / Hostname", type: "text", placeholder: "192.168.1.120" },
        {
          key: "model",
          label: "Model",
          type: "select",
          options: [
            { value: "EM4", label: "EW-DX EM4 (4 channels)" },
            { value: "EM2", label: "EW-DX EM2 (2 channels)" },
            { value: "CHG70N", label: "CHG 70N charger (2 bays)" },
          ],
        },
      ],
    },
  ],
  [
    "sennheiser-spectera",
    {
      id: "sennheiser-spectera",
      kind: "wireless",
      label: "Sennheiser Spectera",
      description:
        "Reads telemetry from a Spectera Base Station over SSCv2, HTTPS on port 443. Set an API password on the base station first (WebUI / LinkDesk) — the API stays disabled until one exists — and enter it below. The username is fixed at controlSennheiser.",
      configSchema: [
        { key: "host", label: "Base Station IP / Hostname", type: "text", placeholder: "192.168.1.130" },
        { key: "port", label: "HTTPS Port", type: "number", placeholder: "443" },
        { key: "password", label: "API Password", type: "password" },
      ],
    },
  ],
]);

export class ProviderRegistry {
  getDescriptors(): IntegrationDescriptor[] {
    return Array.from(PROVIDER_DESCRIPTORS.values());
  }

  getDescriptor(id: string): IntegrationDescriptor | null {
    return PROVIDER_DESCRIPTORS.get(id) ?? null;
  }

  /**
   * Creates and returns a NEW provider instance for providers that have a real
   * driver. Returns null for unknown provider ids.
   * Callers are responsible for the lifecycle of the returned instance.
   */
  createProvider(id: string): DeviceProvider | null {
    switch (id) {
      case "none":
        return new NoneProvider();
      case "shure-ulxd":
        return new ShureUlxd();
      case "shure-axient":
        return new ShureAxient();
      case "shure-psm":
        return new ShurePsm();
      case "shure-charger":
        return new ShureCharger();
      case "sennheiser-ewg4":
        return new SennheiserEwG4();
      case "sennheiser-ewdx":
        return new SennheiserEwDx();
      case "sennheiser-spectera":
        return new SennheiserSpectera();
      default:
        return null;
    }
  }

  /** True when the provider has a real driver. */
  hasDriver(id: string): boolean {
    return DRIVER_IDS.has(id);
  }
}

export const providerRegistry = new ProviderRegistry();
