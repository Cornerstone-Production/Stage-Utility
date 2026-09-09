// The Companion half of the automation page: picking a button, importing the
// ON/OFF pairs as cues, and the tokens that may call one.
//
// Kept out of automation-section.tsx, which is already the longest section in
// settings and is about rules in general. Everything here is about one action
// and one trigger.
//
// NOT unit-tested, deliberately, and this is the honest reason: every one of
// these is a dialog whose failure modes are visual — a picker whose list does
// not scroll, a dialog that opens behind the overlay, a button that renders and
// does nothing. jsdom loads no stylesheet and reports every offsetHeight as 0,
// so a test here would assert that a <button> exists, which is exactly the
// assurance this repo has been burned by. They were driven in a browser instead;
// the server side they call is covered in main/services/routes/cue-routes.test.ts.

import { errorMessage } from "@main/services/errors";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, KeyIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { invoke } from "../../lib/api";
import {
  Button,
  Checkbox,
  Collapsible,
  DialogContent,
  DialogRoot,
  Input,
  NumberInput,
  Separator,
  toast,
} from "../../components/ui";
import { copyText } from "../../lib/clipboard";

// ── Shapes the server sends ───────────────────────────────────────────────────

export interface CompanionButton {
  page: number;
  pageName: string;
  row: number;
  col: number;
  label: string;
  drives: string[];
}

interface ButtonsReply {
  ok: boolean;
  reason?: string;
  buttons: CompanionButton[];
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

interface PairsReply {
  ok: boolean;
  reason?: string;
  pairs: Pair[];
}

interface TokenSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const rowCls = "flex items-center gap-3 py-1";
const labelCls = "w-36 shrink-0 text-caption1 text-fg-muted";

// ── The button picker ─────────────────────────────────────────────────────────

/**
 * The `companion.press` action's params, as a picker rather than three numbers.
 *
 * The three numbers stay: they are what is stored, they are what shows when
 * Companion is unreachable, and they are the escape hatch when a button is not
 * in the export. Picking fills them in — it does not replace them.
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
            value={page}
            min={1}
            max={999}
            onChange={(n) => onChange({ page: n })}
            className="h-7 text-footnote"
          />
        </span>
      </div>
      <div className={rowCls}>
        <span className={labelCls}>Row</span>
        <span className="min-w-0 flex-1">
          <NumberInput
            value={row}
            min={0}
            max={99}
            onChange={(n) => onChange({ row: n })}
            className="h-7 text-footnote"
          />
        </span>
      </div>
      <div className={rowCls}>
        <span className={labelCls}>Column</span>
        <span className="min-w-0 flex-1">
          <NumberInput
            value={col}
            min={0}
            max={99}
            onChange={(n) => onChange({ col: n })}
            className="h-7 text-footnote"
          />
        </span>
      </div>

      <ButtonPickerDialog
        open={open}
        onOpenChange={setOpen}
        onPick={(b) => {
          onChange({ page: b.page, row: b.row, col: b.col, label: b.label || `p${b.page} r${b.row} c${b.col}` });
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
      await invoke("companion:refreshButtons");
      await qc.invalidateQueries({ queryKey: ["companion:buttons"] });
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

// ── Importing ON/OFF pairs ────────────────────────────────────────────────────

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
  const [busy, setBusy] = useState(false);

  const pairs = data?.pairs ?? [];

  // DERIVED, not synchronised. `picked` is null until the operator touches a
  // box, and until then the selection is computed from the server's own
  // suggestion. An effect that seeded it instead would re-tick a box the
  // operator had just unticked on the next refetch, and React now refuses that
  // shape outright.
  const chosen =
    picked ?? new Set(pairs.filter((p) => p.suggested && !p.exists).map((p) => `${p.page}:${p.slug}`));

  const key = (p: Pair) => `${p.page}:${p.slug}`;

  async function run() {
    setBusy(true);
    try {
      const send = pairs.filter((p) => chosen.has(key(p)));
      const r = await invoke<{ created: string[]; skipped: { name: string; why: string }[] }>(
        "automation:importPairs",
        { pairs: send },
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

  return (
    <DialogRoot
      open={open}
      onOpenChange={(v) => {
        // Cleared on close rather than in an effect, so re-opening starts from
        // the suggestion again instead of last time's half-made choice.
        if (!v) setPicked(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <h2 className="text-subheadline font-semibold text-fg">Import from Companion</h2>
        <p className="mb-2 mt-1 text-caption1 text-fg-muted">
          Buttons whose labels differ only by ON/OFF. Each pair becomes two cues you can call by name.
          Every one is created with <span className="text-fg">no service is live</span> on it and a two
          second cooldown. Pairs that drive a projector, television, plug or lighting console are
          ticked for you; tick anything else you want.
        </p>

        {data && !data.ok ? (
          <p className="text-caption1 text-fg-muted">Could not read Companion&rsquo;s configuration: {data.reason}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            {isFetching && pairs.length === 0 && <p className="py-4 text-caption1 text-fg-muted">Reading Companion…</p>}
            {pairs.map((p) => (
              <label
                key={key(p)}
                className="flex items-center gap-2 border-b border-line py-1.5 last:border-0"
              >
                <Checkbox
                  checked={chosen.has(key(p))}
                  disabled={p.exists}
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
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button variant="accent" size="small" disabled={busy || chosen.size === 0} onClick={() => void run()}>
            {busy ? "Importing…" : `Import ${chosen.size} pair${chosen.size === 1 ? "" : "s"}`}
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
        </div>
      </div>
    </Collapsible>
  );
}
