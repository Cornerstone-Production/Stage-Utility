// companion-pane.tsx — pick a Companion button for a Button.
//
// Three ways to the same button, all reading the live Companion export: a search
// over every label on every page, a page dropdown with previous and next arrows
// (an install can have a hundred pages, so the dropdown filters by number or name
// and leaves empty pages out), and the page itself drawn as Companion draws it,
// with its own colours and icons. There are no typed coordinates: a button that is
// not in the export cannot be pressed safely, because the fingerprint refuses it.
//
// The grid shows the page's USED extent, never fewer than 8 by 4, and scrolls
// sideways inside the panel when a page is wider than the panel. A page control
// (page number, up, down) is drawn as a blank key and cannot be picked; a
// reference key is drawn as the button it points at, marked as a reference, and
// picking it presses the reference's own target, as Companion does.
//
// jsdom loads no stylesheet and measures nothing, so the grid's overflow and the
// popover's placement are not unit-tested: they were driven in a browser. What is
// tested is which key a click picks and what it writes.

import { useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";

import type { CompanionPageView } from "@main/services/companion-export";
import { errorMessage } from "@main/services/errors";

import { CompanionPageGrid, CompanionPageSelect, listedPages } from "../components/companion-pages";
import { ErrorNote } from "../components/ui";
import { invoke } from "../lib/api";
import { companionButtonsQuery } from "../lib/companion-buttons";
import { fingerprintFor, type CompanionButton } from "../settings/sections/companion-cues";
import { COMPANION_PRESS, type PressTarget } from "./owned-press";

type PageReply = ({ ok: true } & CompanionPageView) | { ok: false; reason: string };

/** Where the picked button is: the coordinates stored on the Button's own rule. */
export interface PickedCompanion {
  page: number;
  row: number;
  col: number;
  label: string;
}

const MAX_RESULTS = 40;

/** The press action for a picked button, with the identity the reconcile compares. */
export function pressTargetFor(b: CompanionButton): PressTarget {
  return { name: b.label || `p${b.page} r${b.row} c${b.col}`, action: { id: COMPANION_PRESS, params: fingerprintFor(b) } };
}

/** Labelled buttons whose text contains what was typed, in page order. */
export function matchingButtons(buttons: readonly CompanionButton[], typed: string): CompanionButton[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [];
  return buttons.filter((b) => b.label.toLowerCase().includes(q));
}

export function CompanionPane({
  current,
  onPick,
  disabled,
}: {
  current: PickedCompanion | null;
  onPick: (target: PressTarget) => void;
  /** A write is in flight. */
  disabled?: boolean;
}) {
  const buttonsQ = useQuery(companionButtonsQuery);
  const reply = buttonsQ.data;
  const pages = useMemo(() => listedPages(reply?.pages), [reply]);
  const [chosen, setChosen] = useState<number | null>(null);
  const page = chosen ?? current?.page ?? pages[0]?.page ?? null;

  const pageQ = useQuery({
    queryKey: ["companion:page", page],
    queryFn: () => invoke<PageReply>("companion:page", { page }),
    enabled: page !== null && reply?.ok === true,
  });

  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const hits = useMemo(() => matchingButtons(reply?.buttons ?? [], typed), [reply, typed]);

  function pickAt(at: { page: number; row: number; col: number }) {
    const found = reply?.buttons.find((b) => b.page === at.page && b.row === at.row && b.col === at.col);
    if (!found) {
      // The page was drawn from one read and the list from another, five minutes apart at worst.
      setProblem("That button is not in the list Stage Utility last read from Companion. Refresh it under Settings, Integrations, Companion.");
      return;
    }
    setProblem(null);
    onPick(pressTargetFor(found));
  }

  if (buttonsQ.isError) {
    return <ErrorNote>Could not read Companion: {errorMessage(buttonsQ.error)}</ErrorNote>;
  }
  if (reply && !reply.ok) {
    // A picker that drew an empty page here would read as a Companion with nothing on it.
    return (
      <ErrorNote>
        Could not read Companion&rsquo;s configuration{reply.reason ? `: ${reply.reason}` : ""}. Set the host under Settings, Integrations,
        Companion.
      </ErrorNote>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-companion-pane>
      <span className="relative block">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Find a button by label"
          aria-label="Find a Companion button"
          className="h-8 w-full rounded-md border border-line-strong bg-field pl-8 pr-2.5 text-footnote text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </span>
      {typed.trim() !== "" && (
        <div role="group" aria-label="Matching buttons" className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-line">
          {hits.length === 0 ? (
            <p className="px-2.5 py-1.5 text-caption1 text-fg-muted">No labelled button matches.</p>
          ) : (
            hits.slice(0, MAX_RESULTS).map((b) => (
              <button
                key={`${b.page}-${b.row}-${b.col}`}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setChosen(b.page);
                  setTyped("");
                  pickAt(b);
                }}
                className="flex min-w-0 items-baseline justify-between gap-2 border-b border-line px-2.5 py-1.5 text-left text-caption1 text-fg last:border-b-0 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="min-w-0 truncate">{b.label}</span>
                <span className="shrink-0 font-mono text-caption2 text-fg-subtle">
                  {b.pageName} · p{b.page} r{b.row} c{b.col}
                </span>
              </button>
            ))
          )}
          {hits.length > MAX_RESULTS && (
            <p className="px-2.5 py-1.5 text-caption2 text-fg-subtle">{hits.length - MAX_RESULTS} more. Type more of the label.</p>
          )}
        </div>
      )}

      <CompanionPageSelect pages={pages} page={page} onPage={setChosen} />

      <PageBody
        reading={!reply}
        page={page}
        query={pageQ}
        current={current}
        disabled={disabled}
        onPick={pickAt}
      />

      {problem && <ErrorNote>{problem}</ErrorNote>}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-caption1 text-fg-muted">
        <span className="min-w-0 truncate">{current ? current.label || "Picked" : "Pick a button"}</span>
        {current && (
          <span className="font-mono text-caption2">
            page {current.page} · row {current.row} · column {current.col}
          </span>
        )}
      </div>
    </div>
  );
}

/** What stands under the page dropdown: the page's grid, or the one line that says why there is none. */
function PageBody({
  reading,
  page,
  query,
  current,
  disabled,
  onPick,
}: {
  /** The button list has not answered yet. */
  reading: boolean;
  page: number | null;
  query: UseQueryResult<PageReply>;
  current: PickedCompanion | null;
  disabled?: boolean;
  onPick: (at: { page: number; row: number; col: number }) => void;
}) {
  const quiet = "py-3 text-center text-caption1 text-fg-muted";
  if (reading) return <p className={quiet}>Reading Companion…</p>;
  // Checked before the query: with no page there is nothing to ask for, and a disabled
  // query reads as pending for ever.
  if (page === null) return <p className={quiet}>Companion has no page with buttons on it.</p>;
  if (query.isPending) return <p className={quiet}>Reading Companion…</p>;
  if (query.isError) return <ErrorNote>Could not read page {page}: {errorMessage(query.error)}</ErrorNote>;
  const view = query.data;
  if (!view) return <p className={quiet}>Companion has no page with buttons on it.</p>;
  if (!view.ok) return <ErrorNote>Could not read page {page}: {view.reason}</ErrorNote>;
  return (
    <CompanionPageGrid
      view={view}
      pick={{
        onPick,
        disabled,
        isPicked: (at) => current !== null && current.page === at.page && current.row === at.row && current.col === at.col,
      }}
    />
  );
}
