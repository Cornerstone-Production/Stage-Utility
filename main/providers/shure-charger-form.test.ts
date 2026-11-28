// The Shure charger's form asks for bays, and says how many.
//
// The form the wireless panel draws comes from the registry's descriptor. The
// charger's descriptor reused the receivers' fields, so an operator adding an
// SBC charger was asked for "Number of Channels" with a placeholder of 2, while
// the driver held a "Number of Bays" field — with the guidance that one SBC220
// is two bays and up to four link behind one address — that nothing ever read.
//
// Read off the registry the panel and the credential code read, not off source.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { providerRegistry } from "./registry.js";
import { ShureCharger } from "./wireless/shure-charger.js";

describe("the Shure charger form", () => {
  const schema = providerRegistry.getDescriptor("shure-charger")?.configSchema ?? [];
  const count = schema.find((f) => f.key === "channels");

  it("asks for bays, not channels", () => {
    assert.ok(count, "the charger form has no count field");
    assert.equal(count.label, "Number of Bays");
  });

  it("says how bays add up across linked units", () => {
    assert.match(count?.help ?? "", /2 bays/, "the form never says one SBC220 is two bays");
  });

  it("suggests the count the driver falls back to", () => {
    // Left at 0 or blank, the driver uses its own default; the hint says what that is.
    const fallback = (new ShureCharger() as unknown as { defaultChannels: number }).defaultChannels;
    assert.equal(count?.placeholder, String(fallback));
  });
});
