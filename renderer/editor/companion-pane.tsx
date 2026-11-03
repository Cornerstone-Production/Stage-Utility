// companion-pane.tsx — pick a Companion button for a Button.
//
// Three ways to the same button, all reading the live Companion export: a search
// over every label on every page, a page dropdown with previous and next arrows
// (an install can have a hundred pages, so the dropdown filters by number or name
// and leaves empty pages out), and the page itself drawn as Companion draws it,
// with its own colours and icons. There are no typed coordinates: a button that is
// not in the export cannot be pressed safely, because the fingerprint refuses it.
//
// The grid shows the page's USED extent, never fewer than 8 by 4, shrinking its
// keys to fit the panel (it never scrolls sideways), and a line under it names the
// hovered or focused key in full, or the picked one at rest. A page control
// (page number, up, down) is drawn as a blank key and cannot be picked; a
// reference key is drawn as the button it points at, marked as a reference, and
// picking it presses the reference's own target, as Companion does.
//
// Open large shows the same page in a dialog, with bigger keys and type, for a page
// whose labels are unreadable at the panel's width. Picking there picks on the
// Button and closes it; the page it is on is the panel's page, so paging in one
// pages the other.
//
// jsdom loads no stylesheet and measures nothing, so the key sizes, the grid fitting
// its panel and the popover's placement are not unit-tested: they were driven in a
// browser. What is tested is which key a click picks and what it writes.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2Icon, SearchIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";

import { CompanionPageBody, CompanionPageSelect, listedPages, type CompanionPick } from "../components/companion-pages";
import { Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, ErrorNote } from "../components/ui";
import { companionButtonsQuery } from "../lib/companion-buttons";
import { fingerprintFor, type CompanionButton } from "../settings/sections/companion-cues";
import { COMPANION_PRESS, type PressTarget } from "./owned-press";

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

  const [large, setLarge] = useState(false);

  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const hits = useMemo(() => matchingButtons(reply?.buttons ?? [], typed), [reply, typed]);

  function onPickAt(at: { page: number; row: number; col: number }) {
    const found = reply?.buttons.find((b) => b.page === at.page && b.row === at.row && b.col === at.col);
    if (!found) {
      // The page was drawn from one read and the list from another, five minutes apart at worst.
      setProblem("That button is not in the list Stage Utility last read from Companion. Refresh it under Settings, Integrations, Companion.");
      return;
    }
    setProblem(null);
    onPick(pressTargetFor(found));
  }

  /** What a grid needs to pick: the same on the panel and in the large dialog. */
  function pickFor(pickHere: (at: { page: number; row: number; col: number }) => void): CompanionPick {
    return {
      onPick: pickHere,
      disabled,
      current: current ? { text: current.label || "Picked", page: current.page, row: current.row, col: current.col } : null,
      isPicked: (at) => current !== null && current.page === at.page && current.row === at.row && current.col === at.col,
    };
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
                  onPickAt(b);
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

      <div className="flex justify-end">
        <Button variant="transparent" size="small" onClick={() => setLarge(true)} disabled={page === null}>
          <Maximize2Icon className="size-3.5" aria-hidden="true" />
          Open large
        </Button>
      </div>
      <CompanionPageSelect pages={pages} page={page} onPage={setChosen} />
      <CompanionPageBody reading={!reply} page={page} pick={pickFor(onPickAt)} />

      <DialogRoot open={large} onOpenChange={setLarge}>
        <DialogContent
          className="flex max-h-[90vh] max-w-[min(860px,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto"
          // The page list inside is a popover that owns Escape while it is open.
          onEscapeKeyDown={(e) => {
            if ((e.target as Element | null)?.closest?.("[data-escape-first]")) e.preventDefault();
          }}
        >
          <DialogTitle>Pick a Companion button</DialogTitle>
          <DialogDescription className="sr-only">Pick the button this one presses. Picking closes this window.</DialogDescription>
          <CompanionPageSelect pages={pages} page={page} onPage={setChosen} />
          <CompanionPageBody
            reading={!reply}
            page={page}
            size="large"
            pick={pickFor((at) => {
              onPickAt(at);
              setLarge(false);
            })}
          />
        </DialogContent>
      </DialogRoot>

      {problem && <ErrorNote>{problem}</ErrorNote>}
    </div>
  );
}
