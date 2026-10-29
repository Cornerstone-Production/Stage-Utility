// The Mic slots page's inspector: the selected slot, in four cards.
//
//   Who        Position / Person / Label / Empty, and who that is this plan
//   Hardware   mic, what it shows as, in-ear pack, battery source, RF bars
//   Prep       from Planning Center (read-only)            <- see TODO below
//   Placement  channel number, stacked, column width
//
// Every control writes the slot through `onChange`, which lands in the page's one
// edit buffer; nothing here saves.

import { CopyIcon, TrashIcon } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";

import {
  Button,
  ButtonGroup,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  Input,
  NumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "../../components/ui";
import { ColorField } from "../../components/ui/color-field";
import { cn } from "../../lib/cn";
import { useWirelessTelemetry } from "../../main/use-wireless-telemetry";
import { useStageState } from "../../main/use-stage-state";
import { PositionRangeEditor } from "../../settings/sections/position-picker";
import type { WirelessChannel } from "../../settings/types";
import { isPcoPersonId, normalizePcoPersonId } from "@main/services/pco-person-id";
import { plural } from "@main/services/plural";
import { slotTitle } from "./board-preview";

const NONE = "__none__";
const OFFLINE = "__offline__";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h3 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
      <FieldSet>
        <FieldGroup>{children}</FieldGroup>
      </FieldSet>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Field orientation="horizontal" className="px-4 py-2.5">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </FieldContent>
      {children}
    </Field>
  );
}

type Mode = "position" | "person" | "label" | "empty";
function modeOf(slot: Slot): Mode {
  if (slot.link.kind === "static") return "label";
  if (slot.link.kind === "empty") return "empty";
  return slot.link.kind === "pco" && slot.link.matchBy === "person" ? "person" : "position";
}

/** The by-person ID box, with a line saying what it will match. The value is kept
 *  as typed; the resolver normalises it (pco-person-id.ts). */
function PersonIdField({ value, onChange }: { value: string; onChange: (personId: string) => void }) {
  const id = normalizePcoPersonId(value);
  const valid = isPcoPersonId(id);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Input
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder="AC12345678, or the person's Planning Center link"
        aria-label="Planning Center person ID"
      />
      <p className={cn("text-caption2", id && !valid ? "text-danger-11" : "text-fg-subtle")}>
        {!id
          ? "From the person's Planning Center page. Shows them whether or not they are on the plan."
          : !valid
            ? "Not a Planning Center person ID. Copy it from the person's page, e.g. AC12345678."
            : `Planning Center person ${id}.`}
      </p>
    </div>
  );
}

/** What the in-ears row says: their own, the house's, or nothing to say. */
export function earsLine(slot: Slot, resolved: Slot | undefined): string {
  if (resolved?.prep?.ownIems) return "Brings their own";
  if (slot.iemBinding || slot.iemLabel != null) return "House buds";
  return "No pack on this slot";
}

export interface SlotInspectorProps {
  slot: Slot;
  /** The slot as the resolver filled it for the plan being edited. */
  resolved: Slot | undefined;
  boardName: string;
  /** "Left wall · column 3, row 2". */
  where: string;
  /** The board's charger column width, or null when it is not aligned. */
  columnWidthIn: number | null;
  stack: { stacked: boolean; canStack: boolean };
  /** How many OTHER slots on the board share this slot's exact positions. */
  sharesWith: number;
  planLabel: string | null;
  wirelessChannels: WirelessChannel[];
  onChange: (fn: (s: Slot) => Slot) => void;
  onToggleStack: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

export function SlotInspector(props: SlotInspectorProps) {
  const { slot, resolved, boardName, where, columnWidthIn, stack, sharesWith, planLabel, wirelessChannels, onChange } = props;
  const chargerBays = useStageState().state?.chargerBays ?? [];
  const telemetry = useWirelessTelemetry();
  const batteryOf = (channelId: string) => telemetry.find((t) => t.channelId === channelId)?.battery ?? null;
  const channelName = (ch: WirelessChannel) => {
    const b = batteryOf(ch.id);
    return b == null ? ch.label : `${ch.label} · ${b}%`;
  };
  const set = (patch: Partial<Slot>) => onChange((s) => ({ ...s, ...patch }));

  const mode = modeOf(slot);
  const link = slot.link;

  function setMode(next: Mode) {
    if (next === mode) return;
    if (next === "label") set({ link: { kind: "static", label: "", color: "#3b82f6" }, displayName: null, photoUrl: null });
    else if (next === "empty") set({ link: { kind: "empty" }, displayName: null, photoUrl: null });
    else if (next === "person") set({ link: { kind: "pco", matchBy: "person", personId: "" } });
    else set({ link: { kind: "pco", matchBy: "position", positions: [] } });
  }

  // "Offline" is a mic or pack with no network: a typed label in place of the bars.
  const micValue = slot.deviceBinding?.channelId ?? (slot.deviceLabel != null ? OFFLINE : NONE);
  function setMic(v: string) {
    if (v === OFFLINE) set({ deviceBinding: null, deviceLabel: slot.deviceLabel ?? "" });
    else if (v === NONE) set({ deviceBinding: null, deviceLabel: null });
    else set({ deviceBinding: { providerId: "wireless", channelId: v } });
  }
  const iemValue = slot.iemBinding?.channelId ?? (slot.iemLabel != null ? OFFLINE : NONE);
  function setIem(v: string) {
    if (v === OFFLINE) set({ iemBinding: null, iemLabel: slot.iemLabel ?? "" });
    else if (v === NONE) set({ iemBinding: null, iemLabel: null });
    else set({ iemBinding: { providerId: "wireless", channelId: v } });
  }

  // The receiver's own channel name, offered as a one-click fill for "Shows as".
  // It falls back to "Ch N" when the receiver reports none, which is not worth
  // putting on a display.
  const bound = slot.deviceBinding ? wirelessChannels.find((c) => c.id === slot.deviceBinding!.channelId) : undefined;
  const receiverName = bound && !/^Ch \d+$/.test(bound.label) && bound.label !== slot.deviceLabel ? bound.label : null;

  const receivers = wirelessChannels.filter((c) => c.deviceType !== "charger");
  const charge = slot.chargeSource ?? "mic";

  return (
    <div className="flex flex-col gap-3.5" data-mic-inspector="slot">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-fill px-2 font-mono text-footnote font-semibold text-fg">
          {slot.channel || "--"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-subheadline font-semibold text-fg">{resolved?.displayName ?? slotTitle(slot)}</span>
          <span className="truncate text-caption1 text-fg-muted">
            {boardName} · {where}
          </span>
        </div>
        <Button variant="transparent" size="small" iconOnly aria-label="Duplicate slot" onClick={props.onDuplicate}>
          <CopyIcon className="size-3.5 text-fg-muted" />
        </Button>
        <Button variant="transparent" size="small" iconOnly aria-label="Remove slot" onClick={props.onRemove}>
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      <Card title="Who">
        <div className="flex flex-col gap-2 px-4 py-3">
          <ButtonGroup role="group" aria-label="Who fills this slot">
            {(["position", "person", "label", "empty"] as const).map((m) => (
              <Button
                key={m}
                variant={mode === m ? "accent" : "filled"}
                size="small"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m === "position" ? "Position" : m === "person" ? "Person" : m === "label" ? "Label" : "Empty"}
              </Button>
            ))}
          </ButtonGroup>
          {mode === "position" && link.kind === "pco" && link.matchBy === "position" && (
            <>
              <PositionRangeEditor
                positions={link.positions}
                onChange={(positions) => set({ link: { kind: "pco", matchBy: "position", positions } })}
              />
              <p className="text-caption2 text-fg-subtle">
                Tick every position this slot may accept; the first one with someone available fills it. A note pins a position to
                one person, such as 1 for the vocalist noted 1.
              </p>
              {sharesWith > 0 && (
                <p className="text-caption2 text-fg-subtle">
                  Shares people with {plural(sharesWith, "other slot")} configured identically; each fills with a different person,
                  in board order.
                </p>
              )}
            </>
          )}
          {mode === "person" && link.kind === "pco" && link.matchBy === "person" && (
            <PersonIdField value={link.personId} onChange={(personId) => set({ link: { kind: "pco", matchBy: "person", personId } })} />
          )}
          {mode === "label" && link.kind === "static" && (
            <div className="flex items-center gap-2">
              <Input
                value={link.label}
                onChange={(e: ChangeEvent<HTMLInputElement>) => set({ link: { ...link, label: e.target.value } })}
                placeholder="Label (e.g. Backup)"
                aria-label="Label"
                className="min-w-0 flex-1"
              />
              <ColorField label="Slot color" allowAlpha={false} value={link.color} onChange={(color: string) => set({ link: { ...link, color } })} />
            </div>
          )}
        </div>
        {mode !== "empty" && (
          <div className="flex items-center gap-2 px-4 py-2.5 text-caption1 text-fg-muted">
            <span className={cn("size-[7px] rounded-full", resolved?.displayName ? "bg-live-9" : "bg-fg-faint")} />
            {planLabel ? `${planLabel}: ` : "Default layout: "}
            <b className="font-semibold text-fg">{resolved?.displayName ?? (planLabel ? "nobody" : "no one is resolved here")}</b>
          </div>
        )}
      </Card>

      {mode !== "empty" && (
        <Card title="Hardware">
          <Row label="Mic" hint="Offline shows a typed label in the mic row, with no RF bars">
            <Select value={micValue} onValueChange={setMic}>
              <SelectTrigger className="w-44" aria-label="Mic"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                <SelectItem value={OFFLINE}>Offline (manual label)</SelectItem>
                {receivers.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>{channelName(ch)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {(slot.deviceBinding != null || slot.deviceLabel != null) && (
            <Row label="Shows as" hint="Blank shows the frequency">
              <div className="flex items-center gap-1">
                <Input
                  value={slot.deviceLabel ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => set({ deviceLabel: e.target.value })}
                  placeholder="e.g. VOX 3"
                  aria-label="Mic label"
                  className="w-32 font-mono"
                />
                {receiverName && (
                  <Button variant="transparent" size="small" onClick={() => set({ deviceLabel: receiverName })} tooltip={`Use the receiver's own channel name (${receiverName})`}>
                    Use receiver name
                  </Button>
                )}
              </div>
            </Row>
          )}
          <Row label="In-ear pack" hint="Adds an in-ear row with its battery">
            <Select value={iemValue} onValueChange={setIem}>
              <SelectTrigger className="w-44" aria-label="In-ear pack"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                <SelectItem value={OFFLINE}>Offline (manual label)</SelectItem>
                {wirelessChannels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>{channelName(ch)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {(slot.iemBinding != null || slot.iemLabel != null) && (
            <Row label="In-ear label" hint="Shown under the mic label">
              <Input
                value={slot.iemLabel ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => set({ iemLabel: e.target.value })}
                placeholder="e.g. IEM 2"
                aria-label="In-ear label"
                className="w-32 font-mono"
              />
            </Row>
          )}
          <Row label="Battery from" hint={charge === "off" ? "Battery hidden; the mic row shows RF only" : charge === "charger" ? "Reads from the chosen charger bay" : "Reads from the bound transmitter"}>
            <div className="flex flex-col items-stretch gap-1.5">
              <Select
                value={charge}
                onValueChange={(v: string) =>
                  set({ chargeSource: v as "mic" | "charger" | "off", chargeBayId: v === "charger" ? (slot.chargeBayId ?? null) : null })
                }
              >
                <SelectTrigger className="w-44" aria-label="Battery from"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mic">Mic</SelectItem>
                  <SelectItem value="charger">Charger bay</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
              {charge === "charger" && (
                <Select value={slot.chargeBayId ?? NONE} onValueChange={(v: string) => set({ chargeBayId: v === NONE ? null : v })}>
                  <SelectTrigger className="w-44" aria-label="Charger bay"><SelectValue placeholder="Pick a bay" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {chargerBays.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {`${b.connectionName ?? `Charger ${b.chargerIndex}`} · Bay ${b.bay}${b.battery != null ? ` (${b.battery}%)` : ""}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </Row>
          <Row label="RF bars">
            <Switch aria-label="RF bars" checked={!(slot.hideRf ?? false)} onCheckedChange={(v: boolean) => set({ hideRf: !v })} />
          </Row>
        </Card>
      )}

      <Card title="Prep · from Planning Center">
        <Row label="Capsule">
          <span className="font-mono text-footnote font-bold text-fg" data-prep-capsule>
            {resolved?.prep?.capsule ?? "no tag"}
          </span>
        </Row>
        <Row label="In-ears">
          <span className="text-footnote text-fg" data-prep-ears>
            {earsLine(slot, resolved)}
          </span>
        </Row>
        <p className="px-4 py-2.5 text-caption2 text-fg-subtle">
          Tags named Capsule: or IEMs: on their Planning Center profile are picked up automatically.
        </p>
      </Card>

      <Card title="Placement">
        <Row label="Channel number">
          <Input
            value={slot.channel}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ channel: e.target.value })}
            placeholder="01"
            aria-label="Channel number"
            className="w-16 font-mono tabular-nums"
          />
        </Row>
        <Row label="Stacked" hint={stack.stacked ? "Shares a column with the slot above" : stack.canStack ? "Turn on to join the column to its left" : "Nothing to the left to stack onto"}>
          <Switch aria-label="Stacked" checked={stack.stacked} disabled={!stack.stacked && !stack.canStack} onCheckedChange={() => props.onToggleStack()} />
        </Row>
        {columnWidthIn != null && (
          <Row label="Column width" hint={slot.widthIn == null ? "Auto: the board's charger width" : undefined}>
            <div className="flex items-center gap-1">
              <NumberInput
                value={slot.widthIn ?? columnWidthIn}
                step={0.1}
                min={0.1}
                suffix="in"
                className="w-28"
                aria-label="Column width (inches)"
                onChange={(n) => set({ widthIn: n })}
              />
              {slot.widthIn != null && (
                <Button variant="transparent" size="small" onClick={() => set({ widthIn: undefined })}>
                  Auto
                </Button>
              )}
            </div>
          </Row>
        )}
      </Card>
    </div>
  );
}

export function SpacerInspector({
  slot,
  boardName,
  aligned,
  onChange,
  onRemove,
}: {
  slot: Slot;
  boardName: string;
  aligned: boolean;
  onChange: (fn: (s: Slot) => Slot) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5" data-mic-inspector="spacer">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-fill px-2 font-mono text-footnote font-semibold text-fg">↔</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-subheadline font-semibold text-fg">Spacer</span>
          <span className="truncate text-caption1 text-fg-muted">{boardName}</span>
        </div>
        <Button variant="transparent" size="small" iconOnly aria-label="Remove spacer" onClick={onRemove}>
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>
      <Card title="Spacer">
        <Row label="Width" hint={aligned ? "The gap between charger banks" : "Counts once the board is aligned to chargers"}>
          <NumberInput
            value={slot.widthIn ?? 2}
            step={0.5}
            min={0.1}
            suffix="in"
            className="w-28"
            aria-label="Spacer width (inches)"
            onChange={(n) => onChange((s) => ({ ...s, widthIn: n }))}
          />
        </Row>
      </Card>
    </div>
  );
}
