// Bringing a layout in from another install.
//
// Three states, because committing blind to a file off somebody's laptop is the
// wrong shape: pick it, see what is in it, then a report of what landed.
//
// The review runs the SAME collectRefs the server uses rather than a second walk
// of its own, so what this screen promises and what import actually does cannot
// drift apart.

import { useRef, useState } from "react";
import { errorMessage } from "@main/services/errors";
import { useRouter } from "@tanstack/react-router";

import { invoke } from "../../lib/api";
import { Button } from "../../components/ui";
import { cn } from "../../lib/cn";
import { collectRefs } from "@main/services/view-refs";
import type { ViewBundle, ImportReport, UnresolvableRef } from "@main/types/view-bundle";

/** What the review screen shows, derived from the file alone. */
interface Review {
  bundle: ViewBundle;
  rootName: string;
  dependencies: string[];
  slotSets: number;
  notes: number;
  images: number;
  targets: number;
  rebind: UnresolvableRef[];
}

const KIND_LABEL: Record<UnresolvableRef["kind"], string> = {
  wireless: "a wireless channel",
  charger: "a charger bay",
  spl: "an SPL meter",
  sensource: "a people counter zone",
  propresenter: "a ProPresenter instance",
  output: "a screen",
};

function review(bundle: ViewBundle): Review {
  const root = bundle.views[0];
  const refs = collectRefs(bundle.views, root.id);
  return {
    bundle,
    rootName: root.name,
    dependencies: bundle.views.slice(1).map((v) => v.name),
    slotSets: Object.keys(bundle.sideData?.slots ?? {}).length,
    notes: Object.keys(bundle.sideData?.notes ?? {}).length,
    images: Object.keys(bundle.images ?? {}).length,
    targets: (bundle.targets?.osc?.length ?? 0) + (bundle.targets?.rosstalk?.length ?? 0),
    rebind: refs.unresolvable,
  };
}

export function ImportLayout() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Review | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function take(file: File): Promise<void> {
    setError(null);
    setReport(null);
    try {
      const parsed = JSON.parse(await file.text()) as ViewBundle;
      // Refused BY NAME here as well as on the server: picking the config
      // snapshot by mistake is the likely error, and the operator should learn
      // that without a round trip.
      if (parsed?.kind !== "stage-utility-view") {
        throw new Error(`That is a "${String(parsed?.kind ?? "unknown")}" file, not a view export.`);
      }
      if (!Array.isArray(parsed.views) || parsed.views.length === 0) {
        throw new Error("That file has no views in it.");
      }
      setPending(review(parsed));
    } catch (err) {
      setPending(null);
      setError(errorMessage(err));
    }
  }

  async function confirm(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      setReport(await invoke<ImportReport>("views:import", { bundle: pending.bundle }));
      setPending(null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Cleared so picking the same file twice fires onChange again.
          e.target.value = "";
          if (f) void take(f);
        }}
      />
      <Button
        variant="transparent"
        size="small"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void take(f);
        }}
        className={cn(dragging && "ring-1 ring-accent")}
      >
        Import layout…
      </Button>

      {error && (
        <p role="alert" className="mt-2 basis-full rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
          {error}
        </p>
      )}

      {pending && (
        <section className="mt-3 basis-full overflow-hidden rounded-xl border border-line-strong bg-surface">
          <header className="border-b border-line px-4 py-3">
            <h3 className="text-callout font-semibold text-fg">Import layout</h3>
            <p className="mt-0.5 text-caption1 text-fg-subtle">
              {pending.rootName}
              {pending.bundle.source?.server ? ` · from ${pending.bundle.source.server}` : ""}
            </p>
          </header>

          <div className="flex flex-col gap-3 px-4 py-3">
            <Group title="Views">
              <Row label={pending.rootName} sub="the layout you picked" />
              {pending.dependencies.map((n) => (
                <Row key={n} label={n} sub="comes with it — the layout embeds this" tag="embedded" />
              ))}
            </Group>

            {(pending.slotSets > 0 || pending.notes > 0 || pending.images > 0 || pending.targets > 0) && (
              <Group title="Comes with it">
                {pending.slotSets > 0 && <Row label="Slot rows" sub="every service type" tag={String(pending.slotSets)} />}
                {pending.notes > 0 && <Row label="Notes and checklists" sub="keyed to their objects" tag={String(pending.notes)} />}
                {pending.images > 0 && <Row label="Images" sub="identical ones are shared, not duplicated" tag={String(pending.images)} />}
                {pending.targets > 0 && <Row label="OSC and RossTalk targets" sub="a local one of the same id is kept" tag={String(pending.targets)} />}
              </Group>
            )}

            {pending.rebind.length > 0 && <RebindList list={pending.rebind} />}
          </div>

          <footer className="flex justify-end gap-2 border-t border-line bg-fill/40 px-4 py-3">
            <Button variant="transparent" size="small" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" size="small" onClick={() => void confirm()} disabled={busy}>
              Import {pending.bundle.views.length} view{pending.bundle.views.length === 1 ? "" : "s"}
            </Button>
          </footer>
        </section>
      )}

      {report && <ImportResult report={report} onClose={() => setReport(null)} />}
    </>
  );
}

/** "2 objects need a wireless channel" / "1 object needs an SPL meter".
 *  One place, because the review sheet and the report both say it. */
function needLine(kind: UnresolvableRef["kind"], count: number): string {
  return count === 1
    ? `1 object needs ${KIND_LABEL[kind]}`
    : `${count} objects need ${KIND_LABEL[kind]}`;
}

function groupByKind(list: UnresolvableRef[]): Record<string, UnresolvableRef[]> {
  const out: Record<string, UnresolvableRef[]> = {};
  for (const u of list) (out[u.kind] ??= []).push(u);
  return out;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{title}</h4>
      <div className="overflow-hidden rounded-lg border border-line">{children}</div>
    </div>
  );
}

function Row({ label, sub, tag, warn, mono, action, onClick }: {
  label: string; sub?: string; tag?: string; warn?: boolean; mono?: boolean;
  action?: string; onClick?: () => void;
}) {
  const inner = (
    <>
      <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", warn ? "bg-warn-9" : "bg-accent")} />
      <span className="min-w-0 flex-1">
        <span className="block text-footnote text-fg">{label}</span>
        {sub && <span className={cn("block truncate text-caption2 text-fg-subtle", mono && "font-mono")}>{sub}</span>}
      </span>
      {tag && <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-caption2 text-fg-subtle">{tag}</span>}
      {action && <span className="shrink-0 text-caption2 text-accent">{action}</span>}
    </>
  );
  const shared = "flex w-full items-start gap-2.5 border-b border-line px-3 py-2 text-left last:border-b-0";
  return onClick
    ? <button type="button" onClick={onClick} className={cn(shared, "transition-colors hover:bg-fill")}>{inner}</button>
    : <div className={shared}>{inner}</div>;
}

/**
 * The work list.
 *
 * Named individually rather than counted, because the destination is a
 * different rig and rebinding is the expected path — a count tells you there is
 * work but not where. Each entry opens the editor for the view that holds it;
 * selecting the object itself needs an editor change and rides with the inline
 * pickers in the follow-up.
 */
function RebindList({ list, onOpen }: { list: UnresolvableRef[]; onOpen?: (u: UnresolvableRef) => void }) {
  return (
    <>
      {Object.entries(groupByKind(list)).map(([kind, entries]) => (
        <Group key={kind} title={needLine(kind as UnresolvableRef["kind"], entries.length)}>
          {entries.map((u) => (
            <Row
              key={`${u.viewId}:${u.objectId}`}
              label={u.label}
              sub={u.value}
              mono
              warn
              action={onOpen && "Open editor"}
              onClick={onOpen && (() => onOpen(u))}
            />
          ))}
        </Group>
      ))}
      <p className="text-caption1 text-warn-11">
        These keep their bindings. Most render as unconfigured; a screen tile
        instead says the screen no longer exists. Nothing is cleared.
      </p>
    </>
  );
}

/** What landed, and what is left to do. */
function ImportResult({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const router = useRouter();
  return (
    <section className="mt-3 basis-full overflow-hidden rounded-xl border border-line-strong bg-surface">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-callout font-semibold text-fg">
          Imported {report.views.length} view{report.views.length === 1 ? "" : "s"}
        </h3>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        <Group title="Added">
          {report.views.map((v) => (
            <Row
              key={v.id}
              label={v.name}
              sub={v.renamedFrom ? `renamed — a view called "${v.renamedFrom}" was already here` : undefined}
            />
          ))}
          {report.targetsAdded.map((t) => <Row key={t.id} label={`${t.kind.toUpperCase()} target "${t.name}"`} />)}
        </Group>

        {report.targetsKept.length > 0 && (
          <Group title="Left alone">
            {report.targetsKept.map((t) => (
              <Row key={t.id} label={`${t.kind.toUpperCase()} target "${t.name}"`} sub="already here — yours was kept, untouched" />
            ))}
          </Group>
        )}

        {report.images.failed.length > 0 && (
          <Group title="Images that could not be written">
            {report.images.failed.map((f) => <Row key={f} label={f} warn />)}
          </Group>
        )}

        {report.skipped.length > 0 && (
          <Group title="Skipped">
            {report.skipped.map((k) => <Row key={k} label={k} sub="the file used a name that cannot be stored" warn />)}
          </Group>
        )}

        {report.rebind.length > 0 && (
          <RebindList list={report.rebind} onOpen={(u) => router.navigate({ to: `/screens/${u.viewId}/edit` as never })} />
        )}
      </div>
      <footer className="flex justify-end border-t border-line bg-fill/40 px-4 py-3">
        <Button variant="transparent" size="small" onClick={onClose}>Close</Button>
      </footer>
    </section>
  );
}
