// stores.ts — import every persisted store, so the registry is complete.
//
// Registration happens when a store is CONSTRUCTED, which happens when its module
// is first imported. That makes the registry lazy by default, and a lazy registry
// is worse than the hand-maintained list it replaces: a config store whose module
// had not been imported yet would be silently absent from a backup, exactly the
// failure the registry exists to prevent, but now invisible rather than merely
// forgettable.
//
// So config-snapshot imports this, and this imports all of them. The cost is one
// module graph edge; the alternative is a correctness hole that only shows up
// when an operator restores a backup and finds something missing.
//
// A new store belongs here as well as in its own module. The registry test fails
// if the two disagree, so this cannot quietly fall behind.

import "./attendance-store.js";
import "./automation-log.js";
import "./automation-store.js";
import "./baptism-store.js";
import "./baptism-triggers-store.js";
import "./layout-groups-store.js";
import "./layout-templates-store.js";
import "./osc-store.js";
import "./patch-store.js";
import "./presets-store.js";
import "./rosstalk-store.js";
import "./bar-config-store.js";
import "./saved-colors-store.js";
import "./stream-start-store.js";
import "./notes-store.js";
import "./scriptview-config-store.js";
import "./scriptview-layouts-store.js";
import "./scriptview-roles-store.js";
import "./service-timeline-store.js";
import "./kiosk-devices-store.js";
import "./settings-store.js";
import "./signal-store.js";
import "./update-notices-store.js";
import "./slots-store.js";
import "./spl-history-store.js";
import "./views-store.js";
import "./wireless-store.js";

export { allStores, configFilenames, storesOfClass } from "./store-registry.js";
