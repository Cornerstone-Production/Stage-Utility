// Which integration each layout-object type needs in order to show real data.
// Used by the layout editor to group + setup-dim the add-object palette, and by
// placed-object placeholders. Only object types tied to an OPTIONAL integration
// are listed here — core PCO / ProPresenter-driven text objects are intentionally
// omitted (they read from data that's almost always present, and over-dimming
// them would be noise). `id` matches the integration descriptor id.
export const OBJECT_INTEGRATION: Partial<Record<LayoutObjectType, { id: string; label: string }>> = {
  "spl-meter": { id: "smaart", label: "Smaart SPL" },
  "obs-status": { id: "obs", label: "OBS" },
  "people-counter": { id: "sensource", label: "SenSource" },
  "people-graph": { id: "sensource", label: "SenSource" },
  "osc-button": { id: "osc", label: "OSC" },
  "transcript-strip": { id: "prodcom", label: "captions" },
  "charger-battery": { id: "wireless", label: "wireless" },
  "wireless-summary": { id: "wireless", label: "wireless" },
};
