// ProviderRegistry — registers DeviceProvider implementations and exposes
// their descriptors to the UI (via IntegrationManager / wireless handler).

import type { DeviceProvider } from "../types/devices.js";
import type { ConfigField, IntegrationDescriptor } from "../types/integrations.js";
import { NoneProvider } from "./wireless/none-provider.js";
import { ShureAxient } from "./wireless/shure-axient.js";
import { ShureCharger } from "./wireless/shure-charger.js";
import { ShurePsm } from "./wireless/shure-psm.js";
import { ShureUlxd } from "./wireless/shure-ulxd.js";

// Common host/port/channels fields shared across Shure providers.
function shureFields(channelsPlaceholder: string): ConfigField[] {
  return [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100",
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202",
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: channelsPlaceholder,
    },
  ];
}

// Provider ids that have a real driver implementation.
const DRIVER_IDS = new Set<string>(["none", "shure-ulxd", "shure-axient", "shure-psm", "shure-charger"]);

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
