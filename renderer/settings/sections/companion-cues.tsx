// The Companion half of the automation page: picking a button, importing the
// ON/OFF pairs as cues, and the tokens that may call one.
//
// Kept out of automation-section.tsx, which is already the longest section in
// settings and is about rules in general. Everything here is about one action
// and one trigger.
//
// Mostly NOT unit-tested, deliberately, and this is the honest reason: these are
// dialogs whose failure modes are visual — a picker whose list does not scroll, a
// dialog that opens behind the overlay. jsdom loads no stylesheet and reports
// every offsetHeight as 0, so a test for those would assert that a <button>
// exists, which is exactly the assurance this repo has been burned by. They were
// driven in a browser instead; the server side they call is covered in
// main/services/routes/cue-routes.test.ts.
//
// The IMPORT dialog is the exception, in companion-import.test.tsx, because what
// it decides is not visual: which boxes are ticked before anybody touches one,
// and whether the second section's picks reach the request at all. Both are
// assertable as strings, and a wrong default there creates cues that press real
// buttons.

import { errorMessage } from "@main/services/errors";
import { defaultStateVariable } from "@main/services/cue-pairs";
import { togglePairSlug } from "@main/services/companion-export";
import {
  type ButtonFingerprint,
  fingerprintParams,
  missingSentence,
  readFingerprint,
  shortLocation,
} from "@main/services/companion-fingerprint";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon, KeyIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { invoke } from "../../lib/api";
import {
  Button,
  Checkbox,
  Collapsible,
  DialogContent,
  DialogRoot,
  Input,
  NumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Status,
  toast,
} from "../../components/ui";
import { copyText } from "../../lib/clipboard";

// ── Shapes the server sends ───────────────────────────────────────────────────

export interface CompanionButton {
  page: number;
  /** The page's opaque id, which survives a renumber. See companion-export.ts. */
  pageId: string;
  pageName: string;
  row: number;
  col: number;
  label: string;
  drives: string[];
  /** The button's sorted action ids — its identity when somebody moves it. */
  actionIds: string[];
}

interface ButtonsReply {
  ok: boolean;
  reason?: string;
  buttons: CompanionButton[];
}

/**
 * What `POST /api/companion/buttons/refresh` answers.
 *
 * `ok: false` with a `reason` means Companion could not be read at all;
 * `ok: false` with `reconcile.failed` means it was read and the statuses could
 * not be written. Two different sentences for the operator.
 */
interface RefreshReply extends ButtonsReply {
  reconcile?: { applied: number; failed: { ruleId: string; label: string; detail: string }[] };
}

interface Pair {
  base: string;
  slug: string;
  page: number;
  pageName: string;
  on: CompanionButton;
  off: CompanionButton;
  suggested: boolean;
  exists: boolean;
}

/** A labelled button that is not half of a pair, as the import offers it. */
interface Single extends CompanionButton {
  slug: string;
  exists: boolean;
}

interface PairsReply {
  ok: boolean;
  reason?: string;
  pairs: Pair[];
  buttons: Single[];
  /** Companion's custom variable names — what a pair's state can be bound to. */
  customVariables?: string[];
}

interface TokenSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const rowCls = "flex items-center gap-3 py-1";
const labelCls = "w-36 shrink-0 text-caption1 text-fg-muted";

// ── The button's status ───────────────────────────────────────────────────────

/**
 * "just now" / "14 minutes ago" / "3 hours ago" / "2 days ago". PURE.
 *
 * Deliberately coarse: this reads under an amber pill saying a button moved, and
 * the useful fact is "since Thursday", never the second it happened.
 */
export function relativeSince(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const secs = Math.max(0, Math.round((nowMs - at) / 1000));
  if (secs < 90) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  let best = units[0]!;
  for (const unit of units) if (secs >= unit[0]) best = unit;
  const n = Math.round(secs / best[0]);
  return `${n} ${best[1]}${n === 1 ? "" : "s"} ago`;
}

/** The pill's words, PURE — one place, so the row and the editor cannot disagree. */
export function buttonStatusText(
  f: ButtonFingerprint,
  nowMs: number,
): { variant: "neutral" | "warning" | "error"; pill: string; detail: string } | null {
  // Never reconciled (a rule from before this existed, or one written by hand)
  // and a rule with no button chosen both show nothing. A grey "unknown" pill on
  // every old rule would be noise, and the first reconcile adopts them.
  if (f.status === null || f.page < 1) return null;
  if (f.status === "in-place") {
    return { variant: "neutral", pill: "in place", detail: "" };
  }
  if (f.status === "moved") {
    const from = f.movedFrom ? `${shortLocation(f.movedFrom)} \u2192 ${shortLocation(f)}` : shortLocation(f);
    const when = relativeSince(f.lastSeenAt, nowMs);
    return { variant: "warning", pill: "moved", detail: when ? `${from} \u00b7 updated ${when}` : from };
  }
  return {
    variant: "error",
    pill: "button missing",
    detail: `${missingSentence(f)}. Open this rule and pick the button again.`,
  };
}

/**
 * What the last reconcile found about this rule's button.
 *
 * Rendered on the rules list row, where an operator is looking at the cue rather
 * than at Companion. A `missing` cue refuses to press rather than guessing, so
 * this pill is the only warning there is.
 */
export function CueButtonStatus({ params }: { params: Record<string, string | number> }) {
  // A lazy state initializer, not a bare `Date.now()` in the body: reading the
  // clock during render is impure and the lint rule refuses it. The wording is
  // coarse enough ("3 hours ago") that a value fixed at mount is right for as
  // long as the page is open.
  const [nowMs] = useState(() => Date.now());
  const said = buttonStatusText(readFingerprint(params), nowMs);
  if (!said) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      data-cue-button-status={said.pill}
      title={said.detail || undefined}
    >
      <Status variant={said.variant}>{said.pill}</Status>
      {said.detail && (
        <span className="min-w-0 truncate text-caption2 text-fg-subtle">{said.detail}</span>
      )}
    </span>
  );
}

// ── The button picker ─────────────────────────────────────────────────────────

/**
 * The params to merge when somebody TYPES a coordinate, PURE.
 *
 * The coordinate they typed, and "" for every field that described the button
 * the cue used to point at. All five have to go, and each one is a way the
 * escape hatch was not one:
 *
 *  - `status`, because `"missing"` makes the action refuse the press outright,
 *    so a cue rescued by hand went on failing (automation-actions.ts).
 *  - `pageId` and `actionIds`, because the next reconcile matches on them and
 *    would answer `missing` again — or, worse, follow the OLD button to
 *    wherever it now is and overwrite what was just typed.
 *  - `movedFrom`, because "moved from r2c6" under a hand-typed coordinate is a
 *    move nobody made.
 *  - `label`, because the old label is no longer known to be the right one, and
 *    a wrong name on the row is what the operator would act on next.
 *
 * Written as "" rather than left out: these are MERGED over the stored params,
 * so an omitted key keeps yesterday's value. Same reason fingerprintParams
 * writes an empty `movedFrom`.
 */
export function typedCoordinate(
  coordinate: { page: number } | { row: number } | { col: number },
): Record<string, string | number> {
  return { ...coordinate, pageId: "", actionIds: "", status: "", movedFrom: "", label: "" };
}

/**
 * The `companion.press` action's params, as a picker rather than three numbers.
 *
 * The three numbers stay: they are what is stored, they are what shows when
 * Companion is unreachable, and they are how an operator rescues a cue whose
 * button is not in the export. Picking fills them in — it does not replace them.
 *
 * TYPING A COORDINATE CLEARS THE IDENTITY. The stored `pageId`, `actionIds`,
 * `label` and `status` all describe a button the operator has just said is
 * somewhere else, and a `status: "missing"` left beside a hand-typed coordinate
 * makes the action go on REFUSING to press (automation-actions.ts) with nothing
 * on screen saying why — so the numbers looked like an escape hatch and were
 * not one. Cleared, the next reconcile adopts whatever is at the coordinates
 * through its legacy branch, exactly as it adopts a rule written by hand.
 */
export function CompanionPressFields({
  params,
  onChange,
}: {
  params: Record<string, string | number>;
  onChange: (patch: Record<string, string | number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = String(params.label ?? "").trim();
  const page = Number(params.page ?? 0);
  const row = Number(params.row ?? 0);
  const col = Number(params.col ?? 0);
  const placed = Number.isFinite(page) && page > 0;

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className={rowCls}>
        <span className={labelCls}>Button</span>
        <span className="min-w-0 flex-1">
          <Button variant="filled" size="small" onClick={() => setOpen(true)}>
            <SearchIcon className="size-3.5" />
            {chosen || (placed ? `p${page} r${row} c${col}` : "Choose Companion button…")}
          </Button>
        </span>
      </div>
      {placed && (
        <p className="pl-[9.75rem] text-caption2 text-fg-subtle">
          page {page}, row {row}, column {col}
        </p>
      )}

      <div className={rowCls}>
        <span className={labelCls}>Page</span>
        <span className="min-w-0 flex-1">
          <NumberInput
            aria-label="Page"
            value={page}
            min={1}
            max={999}
            onChange={(n) => onChange(typedCoordinate({ page: n }))}
            className="h-7 text-footnote"
          />
        </span>
      </div>
      <div className={rowCls}>
        <span className={labelCls}>Row</span>
        <span className="min-w-0 flex-1">
          <NumberInput
            aria-label="Row"
            value={row}
            min={0}
            max={99}
            onChange={(n) => onChange(typedCoordinate({ row: n }))}
            className="h-7 text-footnote"
          />
        </span>
      </div>
      <div className={rowCls}>
        <span className={labelCls}>Column</span>
        <span className="min-w-0 flex-1">
          <NumberInput
            aria-label="Column"
            value={col}
            min={0}
            max={99}
            onChange={(n) => onChange(typedCoordinate({ col: n }))}
            className="h-7 text-footnote"
          />
        </span>
      </div>

      <ButtonPickerDialog
        open={open}
        onOpenChange={setOpen}
        onPick={(b) => {
          // The fingerprint is written HERE, not left for the next reconcile:
          // re-picking is what an operator does about a `button missing` cue,
          // and it has to clear that status in the same save. See
          // companion-fingerprint.ts.
          onChange(
            fingerprintParams(
              {
                page: b.page,
                row: b.row,
                col: b.col,
                pageId: b.pageId,
                label: b.label || `p${b.page} r${b.row} c${b.col}`,
                actionIds: b.actionIds,
              },
              "in-place",
              new Date().toISOString(),
            ),
          );
          setOpen(false);
        }}
      />
    </div>
  );
}

function ButtonPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (b: CompanionButton) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data, isFetching } = useQuery({
    queryKey: ["companion:buttons"],
    queryFn: () => invoke<ButtonsReply>("companion:buttons"),
    enabled: open,
  });

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const out = new Map<string, CompanionButton[]>();
    for (const b of data?.buttons ?? []) {
      if (needle && !`${b.pageName} ${b.label}`.toLowerCase().includes(needle)) continue;
      const key = `${b.page} · ${b.pageName}`;
      out.set(key, [...(out.get(key) ?? []), b]);
    }
    return [...out.entries()];
  }, [data, search]);

  async function refresh() {
    try {
      // The refresh answers `ok: false` when it read Companion but could not
      // SAVE what it found — a read-only rules file, most likely. Surfaced
      // rather than dropped: the statuses on screen would still be the last
      // good pass's, so nothing here would look wrong.
      const r = await invoke<RefreshReply>("companion:refreshButtons");
      await qc.invalidateQueries({ queryKey: ["companion:buttons"] });
      const failed = r.reconcile?.failed ?? [];
      if (failed.length > 0) {
        toast.error(
          `Read Companion, but could not save ${failed.length} cue status(es): ` +
            `${failed.map((f) => f.label).join(", ")}`,
        );
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="flex-1 text-subheadline font-semibold text-fg">Companion buttons</h2>
          <Button variant="transparent" size="small" onClick={() => void refresh()} disabled={isFetching}>
            <RefreshCwIcon className="size-3.5" /> Refresh
          </Button>
        </div>

        {data && !data.ok ? (
          // A picker that showed an empty list here would look identical to a
          // Companion with no buttons on it.
          <p className="text-caption1 text-fg-muted">
            Could not read Companion&rsquo;s configuration: {data.reason}. Set the host under
            Integrations &rarr; Bitfocus Companion, or type the page, row and column below.
          </p>
        ) : (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search buttons and pages…"
              className="h-8 text-footnote"
            />
            <div className="mt-2 max-h-[50vh] overflow-y-auto">
              {groups.length === 0 && (
                <p className="py-4 text-caption1 text-fg-muted">
                  {isFetching ? "Reading Companion…" : "Nothing matches."}
                </p>
              )}
              {groups.map(([page, buttons]) => (
                <div key={page} className="py-1">
                  <div className="sticky top-0 bg-bg py-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
                    {page}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {buttons.map((b) => (
                      <button
                        key={`${b.page}-${b.row}-${b.col}`}
                        type="button"
                        onClick={() => onPick(b)}
                        className="flex min-w-0 items-baseline gap-2 rounded-md border border-line px-2 py-1 text-left hover:border-line-strong hover:bg-surface"
                      >
                        <span className="min-w-0 flex-1 truncate text-caption1 text-fg">
                          {b.label || <span className="text-fg-subtle">(no label)</span>}
                        </span>
                        <span className="shrink-0 font-mono text-caption2 text-fg-subtle">
                          r{b.row} c{b.col}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

// ── Importing pairs and single buttons ────────────────────────────────────────

/**
 * The footer's label. PURE, and tested — the grammar is the part that reads
 * wrong on a real install.
 *
 * A zero side is omitted rather than written out: "Import 0 pairs and 1 button"
 * is a sentence nobody would type, and the dialog's footer is the last thing
 * read before something presses real buttons.
 */
export function importFooterLabel(pairs: number, buttons: number): string {
  const parts: string[] = [];
  if (pairs > 0) parts.push(`${pairs} pair${pairs === 1 ? "" : "s"}`);
  if (buttons > 0) parts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
  return parts.length === 0 ? "Import" : `Import ${parts.join(" and ")}`;
}

/**
 * Does this single button match what was typed? PURE.
 *
 * The cue NAME is searched as well as the label and the page, because the name is
 * what an operator will say out loud and is often the only part they remember —
 * `take_screens` for a button labelled "Take Screens".
 */
export function matchesButtonSearch(b: Single, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${b.pageName} ${b.label} ${b.slug}`.toLowerCase().includes(needle);
}

/** `switch` / `script` — which Home Assistant object this offer becomes. */
function KindTag({ kind }: { kind: "switch" | "script" }) {
  return (
    <span
      className="shrink-0 rounded bg-field px-1 font-mono text-caption2 text-fg-subtle"
      data-cue-kind={kind}
    >
      {kind}
    </span>
  );
}

/**
 * A section's heading, with an optional Select all / Clear pair.
 *
 * Both act on the rows CURRENTLY VISIBLE in this section only — the caller
 * decides what that means (every pair, or the single buttons a search has
 * filtered to) and passes it in as `selectAllLabel`, which is also the
 * accessible name: the singles section has a search field, and "Select all"
 * alone would not say whether that means every button on Companion or just
 * the seven the search has narrowed to.
 */
function SectionHeading({
  title,
  count,
  onSelectAll,
  onClear,
  selectAllLabel,
  clearLabel,
}: {
  title: string;
  count: number;
  onSelectAll?: () => void;
  onClear?: () => void;
  selectAllLabel?: string;
  clearLabel?: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg py-1">
      <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">{title}</span>
      <span className="text-caption2 text-fg-subtle">{count}</span>
      {onSelectAll && onClear && (
        <span className="ml-auto flex items-center gap-1">
          <Button variant="transparent" size="small" aria-label={selectAllLabel} onClick={onSelectAll}>
            Select all
          </Button>
          <Button variant="transparent" size="small" aria-label={clearLabel} onClick={onClear}>
            Clear
          </Button>
        </span>
      )}
    </div>
  );
}

export function ImportPairsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: () => void;
}) {
  const { data, isFetching } = useQuery({
    queryKey: ["companion:pairs"],
    queryFn: () => invoke<PairsReply>("companion:pairs"),
    enabled: open,
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickedButtons, setPickedButtons] = useState<Set<string>>(new Set());
  /**
   * The state variable chosen per pair, by pair key.
   *
   * Only what the operator TOUCHED, like `picked`: everything else falls back to
   * the default below on every render, so a refetch cannot re-suggest a variable
   * somebody has just set to None. "" is a real entry here — it is how None is
   * remembered — which is why the lookup uses `??` and not `||`.
   */
  const [stateVars, setStateVars] = useState<Record<string, string>>({});
  /**
   * The state variable chosen for a SINGLE button, by button key.
   *
   * Nothing is suggested here, unlike a pair: a pair is plainly a thing being
   * turned on and off, and a single button is only a toggle if the operator
   * says it is. An entry appears when they pick one, and only those buttons
   * send `stateVariable` at all.
   */
  const [toggleVars, setToggleVars] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const pairs = data?.pairs ?? [];
  const singles = data?.buttons ?? [];
  // Empty on a Companion with no custom variables, which is not an error — the
  // State column is simply not offered, rather than offering a dropdown whose
  // only entry is None.
  const customVariables = data?.customVariables ?? [];

  // DERIVED, not synchronised. `picked` is null until the operator touches a
  // box, and until then the selection is computed from the server's own
  // suggestion. An effect that seeded it instead would re-tick a box the
  // operator had just unticked on the next refetch, and React now refuses that
  // shape outright.
  const chosen =
    picked ?? new Set(pairs.filter((p) => p.suggested && !p.exists).map((p) => `${p.page}:${p.slug}`));

  const key = (p: Pair) => `${p.page}:${p.slug}`;
  const buttonKey = (b: Single) => `${b.page}:${b.row}:${b.col}`;
  /** The two cue names a toggle button would get, from the module the route uses. */
  const toggleSlug = (b: Single) => togglePairSlug(b.slug, b.label);
  /** The variable this pair will be bound to: what was chosen, else the guess. */
  const stateVarFor = (p: Pair) => stateVars[key(p)] ?? defaultStateVariable(p.slug, customVariables);

  // Single buttons are NEVER pre-ticked, and this is not an oversight. A pair is
  // plainly a thing being turned on and off; a single button is whatever
  // somebody put on a Companion page, and a ticked-by-default camera shot or
  // playback macro is a cue somebody can say by accident.
  const shown = singles.filter((b) => matchesButtonSearch(b, search));

  async function run() {
    setBusy(true);
    try {
      // The binding travels with the pair, so the `_on` rule is created with it
      // rather than needing a second edit. Blank is an optimistic pair.
      const send = pairs
        .filter((p) => chosen.has(key(p)))
        .map((p) => ({ ...p, stateVariable: stateVarFor(p) }));
      // `stateVariable` is on a button only when one was chosen. A button
      // without it is a single cue and a Home Assistant script, as before.
      const sendButtons = singles
        .filter((b) => pickedButtons.has(buttonKey(b)))
        .map((b) => {
          const variable = toggleVars[buttonKey(b)] ?? "";
          return variable ? { ...b, stateVariable: variable } : b;
        });
      const r = await invoke<{ created: string[]; skipped: { name: string; why: string }[] }>(
        "automation:importPairs",
        { pairs: send, buttons: sendButtons },
      );
      // Both halves reported. "12 created" alone hides the four that clashed.
      if (r.created.length) toast.success(`Created ${r.created.length} cue${r.created.length === 1 ? "" : "s"}`);
      if (r.skipped.length) toast.error(`Skipped ${r.skipped.length}: ${r.skipped.map((s) => s.name).join(", ")}`);
      if (!r.created.length && !r.skipped.length) toast.error("Nothing was selected");
      onImported();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const total = chosen.size + pickedButtons.size;

  return (
    <DialogRoot
      open={open}
      onOpenChange={(v) => {
        // Cleared on close rather than in an effect, so re-opening starts from
        // the suggestion again instead of last time's half-made choice.
        if (!v) {
          setPicked(null);
          setPickedButtons(new Set());
          setStateVars({});
          setToggleVars({});
          setSearch("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <h2 className="text-subheadline font-semibold text-fg">Import from Companion</h2>
        <p className="mb-2 mt-1 text-caption1 text-fg-muted">
          Every cue is created with <span className="text-fg">no service is live</span> on it and a three
          second cooldown. Pairs that drive a projector, television, plug or lighting console are ticked
          for you; nothing else is.
        </p>

        {data && !data.ok ? (
          <p className="text-caption1 text-fg-muted">Could not read Companion&rsquo;s configuration: {data.reason}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            {isFetching && pairs.length === 0 && singles.length === 0 && (
              <p className="py-4 text-caption1 text-fg-muted">Reading Companion…</p>
            )}

            <SectionHeading
              title="ON/OFF pairs"
              count={pairs.length}
              selectAllLabel="Select all pairs"
              clearLabel="Clear pairs"
              onSelectAll={() => {
                const next = new Set(chosen);
                for (const p of pairs) if (!p.exists) next.add(key(p));
                setPicked(next);
              }}
              onClear={() => {
                const next = new Set(chosen);
                for (const p of pairs) next.delete(key(p));
                setPicked(next);
              }}
            />
            <p className="pb-1 text-caption2 text-fg-subtle">
              Buttons whose labels differ only by ON/OFF. Each becomes two cues and one Home Assistant
              switch.
              {customVariables.length > 0 && (
                <>
                  {" "}
                  Pick a <span className="text-fg">state</span> variable and the switch reports what the
                  device is doing rather than what it was asked to do.
                </>
              )}
            </p>
            {pairs.length === 0 && !isFetching && (
              <p className="py-2 text-caption1 text-fg-muted">No ON/OFF pairs on this Companion.</p>
            )}
            {pairs.map((p) => (
              // A DIV with the label around the checkbox and the words only.
              // With the whole row as one <label>, every click on the State
              // select also toggled the checkbox — choosing a variable
              // unticked the pair it was for.
              <div key={key(p)} className="flex items-center gap-2 border-b border-line py-1.5">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <Checkbox
                    checked={chosen.has(key(p))}
                    disabled={p.exists}
                    aria-label={`${p.base} · ${p.pageName}`}
                    onCheckedChange={(v) => {
                      const next = new Set(chosen);
                      if (v) next.add(key(p));
                      else next.delete(key(p));
                      setPicked(next);
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-footnote text-fg">{p.base}</span>
                    <span className="block truncate text-caption2 text-fg-subtle">
                      {p.pageName} · {p.slug}_on / {p.slug}_off
                      {p.exists ? " · already imported" : ""}
                    </span>
                  </span>
                </label>
                {/* Offered only when Companion HAS custom variables, and never
                    for a pair that is already imported — its cues exist, and
                    the binding is an edit to the rule from here on. */}
                {customVariables.length > 0 && !p.exists && (
                  <Select value={stateVarFor(p)} onValueChange={(v) => setStateVars({ ...stateVars, [key(p)]: v })}>
                    {/* The PAGE is in the accessible name, exactly as the
                        checkbox's is: the fixture Companion has "Projectors" on
                        two pages, and two selects called "State variable for
                        Projectors" are indistinguishable to a screen reader and
                        to anything driving the page. */}
                    <SelectTrigger
                      className="w-40 shrink-0"
                      aria-label={`State variable for ${p.base} · ${p.pageName}`}
                    >
                      <SelectValue placeholder="No state" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">No state</SelectItem>
                      {customVariables.map((name) => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <KindTag kind="switch" />
              </div>
            ))}

            <div className="mt-3">
              <SectionHeading
                title="Single buttons"
                count={singles.length}
                selectAllLabel={`Select all ${shown.filter((b) => !b.exists).length} shown`}
                clearLabel="Clear single buttons"
                onSelectAll={() => {
                  const next = new Set(pickedButtons);
                  for (const b of shown) if (!b.exists) next.add(buttonKey(b));
                  setPickedButtons(next);
                }}
                onClear={() => {
                  const next = new Set(pickedButtons);
                  for (const b of shown) next.delete(buttonKey(b));
                  setPickedButtons(next);
                }}
              />
              <p className="pb-1 text-caption2 text-fg-subtle">
                Every other labelled button. Each becomes one cue and one Home Assistant script — nothing
                here is ticked for you.
                {customVariables.length > 0 && (
                  <>
                    {" "}
                    A button that is really a <span className="text-fg">toggle</span> — one key for both
                    directions — becomes an ON/OFF pair instead when you give it a state variable, so Home
                    Assistant gets a switch rather than a button that snaps back.
                  </>
                )}
              </p>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search buttons, pages and cue names…"
                className="mb-1 h-7 text-footnote"
                aria-label="Search single buttons"
              />
              {shown.length === 0 && !isFetching && (
                <p className="py-2 text-caption1 text-fg-muted">
                  {singles.length === 0 ? "Every labelled button is part of a pair." : "Nothing matches."}
                </p>
              )}
              {shown.map((b) => {
                const chosenVar = toggleVars[buttonKey(b)] ?? "";
                return (
                  // A DIV with the label around the checkbox and the words only,
                  // exactly as the pairs rows are: with the whole row as one
                  // <label>, every click on the select also toggled the
                  // checkbox, so choosing a variable unticked the button it was
                  // for.
                  <div key={buttonKey(b)} className="flex items-center gap-2 border-b border-line py-1.5">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <Checkbox
                        checked={pickedButtons.has(buttonKey(b))}
                        disabled={b.exists}
                        aria-label={`${b.label} · ${b.pageName}`}
                        onCheckedChange={(v) => {
                          const next = new Set(pickedButtons);
                          if (v) next.add(buttonKey(b));
                          else next.delete(buttonKey(b));
                          setPickedButtons(next);
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-footnote text-fg">{b.label}</span>
                        <span className="block truncate text-caption2 text-fg-subtle">
                          {b.pageName} · {chosenVar ? `${toggleSlug(b)}_on / ${toggleSlug(b)}_off` : b.slug}
                          {b.exists ? " · already imported" : ""}
                        </span>
                      </span>
                    </label>
                    {/* Offered only when Companion HAS custom variables, and
                        never for a button that is already imported. */}
                    {customVariables.length > 0 && !b.exists && (
                      <Select
                        value={chosenVar}
                        onValueChange={(v) => {
                          setToggleVars({ ...toggleVars, [buttonKey(b)]: v });
                          // Choosing a variable TICKS the row. Nothing here is
                          // ticked for you, but picking a variable for one
                          // button is the operator saying they want that button
                          // — and in a browser the choice otherwise sat there
                          // with the footer still reading "Import 3 pairs" and
                          // the button imported as nothing at all. Clearing it
                          // does not untick: unticking is the checkbox's job.
                          if (v) setPickedButtons(new Set(pickedButtons).add(buttonKey(b)));
                        }}
                      >
                        <SelectTrigger
                          className="w-40 shrink-0"
                          aria-label={`Toggle with state for ${b.label} · ${b.pageName}`}
                        >
                          <SelectValue placeholder="Not a toggle" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">Not a toggle</SelectItem>
                          {customVariables.map((name) => (
                            <SelectItem key={name} value={name}>{name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <KindTag kind={chosenVar ? "switch" : "script"} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="accent"
            size="small"
            disabled={busy || total === 0}
            onClick={() => void run()}
          >
            {busy ? "Importing…" : importFooterLabel(chosen.size, pickedButtons.size)}
          </Button>
          <Button variant="transparent" size="small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

// ── Tokens and the Home Assistant config ──────────────────────────────────────

export function CueAccessCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["cues:tokens"],
    queryFn: () => invoke<{ tokens: TokenSummary[] }>("cues:tokens"),
  });
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const tokens = data?.tokens ?? [];

  const refresh = () => void qc.invalidateQueries({ queryKey: ["cues:tokens"] });

  async function mint() {
    try {
      const r = await invoke<{ secret: string }>("cues:mintToken", { label });
      // Shown once, and only here. There is no route that can return it again.
      setMinted(r.secret);
      setLabel("");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function showYaml() {
    try {
      const r = await invoke<{ yaml: string }>("cues:homeAssistantYaml");
      await copyText(r.yaml);
      toast.success("Home Assistant config copied to the clipboard");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Collapsible
      label="Calling cues"
      summary={`${tokens.length} token${tokens.length === 1 ? "" : "s"}`}
      className="su-card px-4 py-2.5"
    >
      <div className="flex flex-col gap-2 pt-2">
        <p className="text-caption1 text-fg-muted">
          A cue is only reachable with a token. Mint one per caller — one for Home Assistant, one for a
          script — so you can revoke it on its own.
        </p>

        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is calling? e.g. Home Assistant"
            className="h-7 flex-1 text-footnote"
          />
          <Button variant="filled" size="small" disabled={!label.trim()} onClick={() => void mint()}>
            <KeyIcon className="size-3.5" /> Mint
          </Button>
        </div>

        {minted && (
          <div className="rounded-md border border-amber-6 bg-amber-2/60 p-2">
            <p className="text-caption1 text-fg">
              Copy this now — it is not stored and cannot be shown again.
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-field px-2 py-1 font-mono text-caption2 text-fg">
                {minted}
              </code>
              <Button
                variant="transparent"
                size="small"
                onClick={async () => {
                  await copyText(minted);
                  toast.success("Copied");
                }}
              >
                <CopyIcon className="size-3.5" /> Copy
              </Button>
              <Button variant="transparent" size="small" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {tokens.map((t) => (
          <div key={t.id} className="flex items-center gap-2 border-b border-line py-1 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-footnote text-fg">{t.label}</span>
              <span className="block text-caption2 text-fg-subtle">
                {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
              </span>
            </span>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label={`Revoke ${t.label}`}
              onClick={async () => {
                try {
                  await invoke("cues:revokeToken", { id: t.id });
                  refresh();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <Trash2Icon className="size-3.5 text-red-10" />
            </Button>
          </div>
        ))}

        <Separator />
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-caption1 text-fg-muted">
            Home Assistant config for every cue on this server — one <code>rest_command</code> each, and a
            switch per ON/OFF pair.
          </p>
          <Button variant="transparent" size="small" onClick={() => void showYaml()}>
            <CopyIcon className="size-3.5" /> Copy YAML
          </Button>
          {/* Clipboard writes are a secure-context API and fail on the plain-HTTP
              LAN address every real install answers on — see prod-insecure-context
              notes. A plain anchor download works there, so it stays even though
              Copy YAML does not always. */}
          <Button variant="transparent" size="small" asChild>
            <a href="/api/cues/home-assistant.yaml" download>
              <DownloadIcon className="size-3.5" /> Download YAML
            </a>
          </Button>
        </div>
      </div>
    </Collapsible>
  );
}
