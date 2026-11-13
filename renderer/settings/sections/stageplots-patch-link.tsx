// stageplots-patch-link.tsx — a connection point's Patch device field in the inspector.
//
// Not linked: "Link to patch device" opens the picker in place, a sheet and then a device
// (its colour, name, kind and connectors), with Cancel and Link. Linked: the device's row
// with Unlink; the label and colour above are locked while the link holds (the inspector
// does that). Unlinked (the patch cannot be read, or the device is gone): the same row,
// dashed, saying why, with the last name and colour kept. Linking and unlinking are draft
// edits like any other: nothing is saved until Save. Nothing here writes to the patch.

import { useState } from "react";
import { LinkIcon } from "lucide-react";

import { PATCH_KIND_LABELS, type PatchDevice, type PatchDeviceKind } from "@main/types/patch";
import type { PlotItem } from "@main/types/stageplots";
import { labelOf, swatchOf, type LinkResolution, type PatchRead } from "@main/services/stageplots-patch-link";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import type { EditorAction } from "../../main/stageplots/editor-state";
import { Mono } from "../../main/stageplots/mono";
import { eyebrow } from "./stageplots-shared";

/** "16 in · 4 out", leaving out a side the device has none of. */
export function ioText(d: { inputs: number; outputs: number }): string {
  return [d.inputs > 0 ? `${d.inputs} in` : null, d.outputs > 0 ? `${d.outputs} out` : null].filter(Boolean).join(" · ");
}

const kindName = (kind: PatchDeviceKind) => PATCH_KIND_LABELS[kind] ?? kind;

/** A link struck through, as the approved mockup draws Unlink: lucide's own unlink breaks the
 *  chain instead, which reads as a different control beside the Link button's chain. */
function UnlinkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

function Dot({ color, lost = false }: { color: string | null; lost?: boolean }) {
  return color ? (
    // The colour is data: one of the patch sheet's ten swatches.
    <span className={cn("size-2.5 flex-none rounded-full", lost && "opacity-55")} style={{ background: color }} aria-hidden />
  ) : (
    <span className={cn("size-2.5 flex-none rounded-full border border-dashed border-fg-subtle", lost && "opacity-55")} aria-hidden />
  );
}

const rowClass = "flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-[9px] py-[7px] text-caption1";

function Picker({ item, patch, dispatch, onDone }: { item: PlotItem; patch: PatchRead | null; dispatch: (a: EditorAction) => void; onDone: () => void }) {
  const sheets = patch?.ok ? patch.file.sheets : [];
  const [sheetId, setSheetId] = useState(() => (sheets.find((s) => s.devices.length > 0) ?? sheets[0])?.id ?? "");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const sheet = sheets.find((s) => s.id === sheetId) ?? null;
  const device = sheet?.devices.find((d) => d.id === deviceId) ?? null;

  const link = (d: PatchDevice) => {
    if (!sheet) return;
    dispatch({ type: "link", id: item.id, link: { sheetId: sheet.id, deviceId: d.id, lastName: labelOf(d.name), lastColor: swatchOf(d.color) } });
    onDone();
  };

  let body: React.ReactNode;
  if (patch === null) body = <p className="text-caption1 text-fg-subtle">Reading the patch sheet…</p>;
  else if (!patch.ok) body = <p className="text-caption1 text-warn-11">The patch sheet cannot be read right now. Try again in a moment.</p>;
  else if (sheets.length === 0) body = <p className="text-caption1 text-fg-subtle">The patch has no sheets yet. Add devices on the patch editor first.</p>;
  else {
    body = (
      <>
        <select
          aria-label="Patch sheet"
          value={sheetId}
          onChange={(e) => {
            setSheetId(e.target.value);
            setDeviceId(null);
          }}
          className="h-7 w-full rounded-md border border-line-strong bg-field px-1.5 text-footnote text-fg focus:border-focus focus:ring-1 focus:ring-focus focus:outline-none"
        >
          {sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {sheet && sheet.devices.length > 0 ? (
          <div role="listbox" aria-label="Devices" className="flex max-h-[220px] flex-col gap-px overflow-auto">
            {sheet.devices.map((d) => (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={d.id === deviceId}
                onClick={() => setDeviceId(d.id)}
                onDoubleClick={() => link(d)}
                className="grid h-8 w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 text-left text-footnote text-fg hover:bg-fill aria-selected:bg-accent-soft"
              >
                <Dot color={swatchOf(d.color)} />
                <span className="min-w-0 truncate">
                  <Mono text={d.name} />
                  <span className="ml-1.5 text-caption1 text-fg-muted">{kindName(d.kind)}</span>
                </span>
                <small className="text-[11px] text-fg-subtle">
                  <Mono text={ioText(d)} />
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-caption1 text-fg-subtle">No devices on this sheet.</p>
        )}
        <p className="text-caption1 text-fg-subtle">Linking takes the device&apos;s name and color.</p>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-[5px]" data-testid="link-pick">
      <span className={eyebrow}>Link to patch device</span>
      {body}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="transparent" size="small" onClick={onDone}>
          Cancel
        </Button>
        {patch?.ok && sheets.length > 0 && (
          <Button variant="accent" size="small" disabled={!device} onClick={() => device && link(device)}>
            Link
          </Button>
        )}
      </div>
    </div>
  );
}

const LOST: Record<"unavailable" | "removed", { status: string; hint: string; tap: string }> = {
  unavailable: {
    status: "unlinked · patch sheet unavailable",
    hint: "Showing the last name and color it had. It follows the device again once the patch sheet can be read.",
    tap: "A tap lists the point's own inputs, without patch channels, until the sheet is back.",
  },
  removed: {
    status: "unlinked · device removed",
    hint: "Showing the last name and color it had. The device is gone from the patch sheet: unlink to edit them, or to link another device.",
    tap: "A tap lists the point's own inputs, without patch channels.",
  },
};

/**
 * The Patch device field of a connection point. `item` is the point as shown (its label and
 * colour resolved), `link` its resolution (undefined until the patch has answered, or when it
 * is not linked).
 */
export function PatchDeviceField({
  item,
  link,
  patch,
  dispatch,
}: {
  item: PlotItem;
  link: LinkResolution | undefined;
  patch: PatchRead | null;
  dispatch: (a: EditorAction) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (!item.patchLink) {
    if (picking) return <Picker key={item.id} item={item} patch={patch} dispatch={dispatch} onDone={() => setPicking(false)} />;
    return (
      <div className="flex flex-col gap-[5px]">
        <span className={eyebrow}>Patch device</span>
        <Button variant="filled" size="small" className="self-start" onClick={() => setPicking(true)}>
          <LinkIcon className="size-3.5" />
          Link to patch device
        </Button>
      </div>
    );
  }
  const unlink = (
    <Button variant="transparent" size="small" onClick={() => dispatch({ type: "unlink", id: item.id, label: item.label, color: item.color })}>
      <UnlinkGlyph className="size-3.5" />
      Unlink
    </Button>
  );
  if (link?.state === "unlinked") {
    const says = LOST[link.reason];
    return (
      <>
        <div className="flex flex-col gap-[5px]" data-testid="link-lost">
          <span className={eyebrow}>Patch device</span>
          <div className={cn(rowClass, "border-dashed")}>
            <Dot color={link.color} lost />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-footnote font-medium text-fg">
                <Mono text={link.name || "Unlabelled"} />
              </b>
              <small className="block text-[11px] leading-[14px] text-warn-11">{says.status}</small>
            </span>
            {unlink}
          </div>
          <p className="text-caption1 text-fg-subtle">{says.hint}</p>
        </div>
        <div className="flex flex-col gap-[5px]">
          <span className={eyebrow}>In /stageplots</span>
          <p className="text-caption1 text-fg-muted">{says.tap}</p>
        </div>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-[5px]" data-testid="link-on">
      <span className={eyebrow}>Patch device</span>
      <div className={rowClass}>
        <Dot color={item.color} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-footnote font-medium text-fg">
            <Mono text={item.label || "Unlabelled"} />
          </b>
          <small className="block text-[11px] leading-[14px] text-fg-subtle">
            {link ? <Mono text={[kindName(link.device.kind), link.sheet, ioText(link.device)].filter(Boolean).join(" · ")} /> : "Reading the patch sheet…"}
          </small>
        </span>
        {unlink}
      </div>
    </div>
  );
}
