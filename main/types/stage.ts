// Shared stage types — frontend mirrors these shapes exactly.
//
// A barrel. The declarations moved into the modules below when this file reached
// 1,509 lines; everything is re-exported here so `from "../types/stage.js"`
// keeps working at all 200-odd import sites, and the renderer's `@main/types/stage`
// with it.
//
// Import from a module directly when you are inside main/ and know which one you
// want; import from here when you want several, or from the renderer.

export * from "./views.js";
export * from "./live.js";
export * from "./pvp.js";
export * from "./history.js";
export * from "./baptism.js";
export * from "./pco.js";
export * from "./state.js";
export * from "./patch.js";
export * from "./scores.js";
