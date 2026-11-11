// lib/json.ts — the loose JSON the kit writes and reads back: seeded bodies for the app's API and
// Planning Center's JSON:API documents. The server validates them, so the kit does not type them.

export type Json = Record<string, any>;
