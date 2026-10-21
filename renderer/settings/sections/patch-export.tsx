import { DropdownMenu } from "radix-ui";
import { DownloadIcon } from "lucide-react";

import { Button, MENU_ITEM, menuContent } from "../../components/ui";

/** Why the export is unavailable while there are unsaved edits. */
export const EXPORT_BLOCKED = "Save your changes first — the export comes from the saved sheet";

/**
 * The URL a sheet's export is served from, for one format.
 *
 * `plan` is set only on the "This week" target — the export then resolves the
 * plan's variant and tweaks server-side, the same way the table on screen does.
 */
export function exportUrl(
  format: "csv" | "xlsx",
  sheetId: string,
  variantId: string | null,
  plan: { planId: string | null; serviceTypeId: string | null } | null,
): string {
  const q = new URLSearchParams({ sheetId, format });
  if (plan?.planId) {
    q.set("planId", plan.planId);
    if (plan.serviceTypeId) q.set("serviceTypeId", plan.serviceTypeId);
  } else if (variantId) {
    q.set("variantId", variantId);
  }
  return `/api/patch/export?${q.toString()}`;
}

/**
 * Export for the active sheet, as CSV or Excel.
 *
 * The export is served from the SAVED file, so it is deliberately unavailable
 * while there are unsaved edits: handing back a document that differs from the
 * screen is the one failure a patch sheet cannot afford, and it would be silent.
 *
 * Each format is a plain link rather than a fetch — the browser then handles the
 * file and honours the Content-Disposition filename, which a blob round-trip
 * would discard.
 */
export function ExportMenu({
  sheetId,
  variantId,
  plan,
  dirty,
}: {
  sheetId: string;
  variantId: string | null;
  plan: { planId: string | null; serviceTypeId: string | null } | null;
  dirty: boolean;
}) {
  const blocked = dirty ? EXPORT_BLOCKED : undefined;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/* `title` says why for assistive tech and tests; `tooltip` is what a
            sighted operator hovering the greyed-out button actually sees. */}
        <Button variant="filled" size="small" disabled={dirty} title={blocked} tooltip={blocked}>
          <DownloadIcon className="size-3.5" /> Export <span className="text-fg-subtle">CSV · Excel</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuContent()}>
          <DropdownMenu.Item asChild>
            <a href={exportUrl("csv", sheetId, variantId, plan)} className={MENU_ITEM}>Export CSV</a>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <a href={exportUrl("xlsx", sheetId, variantId, plan)} className={MENU_ITEM}>Export Excel</a>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
