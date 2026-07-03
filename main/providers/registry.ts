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
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100",
      help: "IP or hostname of the Shure receiver/charger on the network. Give the device a static IP (in its network settings) so it stays reachable.",
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202",
      help: "The device's control/telemetry TCP port — 2202 for most Shure networked gear (ULX-D, Axient, PSM). Change only if your device uses a non-standard port.",
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: channelsPlaceholder,
      help: "How many RF channels this device exposes (e.g. 4 for a quad ULX-D, 2 for a PSM transmitter). Sets how many channels appear in the slot pickers.",
    },
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
      configSchema: [
        { key: "host", label: "Device IP / Hostname", type: "text", placeholder: "192.168.1.120" },
        { key: "port", label: "SSC Port", type: "number", placeholder: "45" },
        {
          key: "channels",
          label: "Number of Channels",
          type: "number",
          placeholder: "2",
          help: "Sennheiser SSC (Sound Control) over UDP, port 45. Best-effort / hardware-unverified — validate against your gear; set SENNHEISER_DEBUG=1 to log raw frames if values read blank.",
        },
      ],
    },
  ],
  [
    "sennheiser-ewdx",
    {
      id: "sennheiser-ewdx",
      kind: "wireless",
      label: "Sennheiser EW-DX",
      configSchema: [
        {
          key: "host",
          label: "Device IP / Hostname",
          type: "text",
          placeholder: "192.168.1.120",
          help: "IP or hostname of the EW-DX receiver (EM2/EM4) or CHG 70N charger. Sennheiser SSC over UDP port 45 — give it a static IP so it stays reachable.",
        },
        {
          key: "model",
          label: "Model",
          type: "select",
          options: [
            { value: "EM4", label: "EW-DX EM4 (4 channels)" },
            { value: "EM2", label: "EW-DX EM2 (2 channels)" },
            { value: "CHG70N", label: "CHG 70N charger (2 bays)" },
          ],
          help: "Sets how many channels/bays appear and how telemetry is read.",
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
      configSchema: [
        {
          key: "host",
          label: "Base Station IP / Hostname",
          type: "text",
          placeholder: "192.168.1.130",
          help: "IP or hostname of the Spectera Base Station. SSCv2 over HTTPS (port 443) on your LAN.",
        },
        { key: "port", label: "HTTPS Port", type: "number", placeholder: "443", help: "The base station's HTTPS API port (443 unless changed)." },
        {
          key: "password",
          label: "API Password",
          type: "password",
          help: "The API password set on the base station (WebUI / LinkDesk). Username is fixed (controlSennheiser). API access is disabled until a password is set on the device.",
        },
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
