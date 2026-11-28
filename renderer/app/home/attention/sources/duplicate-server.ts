// Another server answering discovery with this server's id.
//
// Screens and Mac outputs bind to a server by its id, so two servers carrying one
// id both answer the same screens, which then switch between them: reloading,
// and reporting their health to whichever answered last. The server finds the
// other one itself (kiosk-responder's duplicate-id check) and says so in
// StageState; this only words it. The fix is on Advanced, where the id is.

import { SERVER_ID_FLASH } from "../../../../settings/sections/server-id-field";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

export const duplicateServer: AttentionSource = {
  id: "duplicate-server",
  items(input: AttentionInput): AttentionItem[] {
    // A server older than the field says nothing, and nothing is listed.
    const duplicates = input.state.serverIdentity?.duplicates ?? [];
    const live = input.mood === "live";
    return duplicates.map((d) => ({
      key: attentionKey("duplicate-server", d.address),
      severity: live ? ("critical" as const) : ("warn" as const),
      title: "Another server shares this server's id",
      detail: `${d.address} answers as this server · screens may jump between the two`,
      fix: { label: "Open setting", route: "/settings/advanced/network", flash: SERVER_ID_FLASH },
    }));
  },
};
