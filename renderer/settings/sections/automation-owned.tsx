// automation-owned.tsx — "Belongs to a button": the commands a Button made for
// itself, listed apart from the commands somebody wrote.
//
// A Button set to press a Companion button or an app action keeps that press as a
// command of its own (`ownedBy` on the rule). It still fires, logs and obeys
// Simulate and Disarm like any command, so it is listed here, collapsed, rather
// than hidden. When its Button goes the command is KEPT and the row says so:
// nothing here is ever deleted for the operator, and Delete is theirs to press.

import { useState } from "react";
import { ChevronRightIcon, Trash2Icon } from "lucide-react";

import { calledCueName } from "@main/services/cue-aliases";
import { errorMessage } from "@main/services/errors";

import { confirm, Button, toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import type { CueUse } from "./cue-usage";
import type { RuleWithIssues } from "./automation-section";

/** Why an owned rule's Button is not holding it, or null while it is. */
export type OrphanKind = "removed" | "repointed";

/** The Button an owned rule names, found among every Button the usage lists, or null when none has that id. */
export function ownerUse(
  rule: Pick<RuleWithIssues, "ownedBy">,
  usage: ReadonlyMap<string, readonly CueUse[]> | undefined,
): { use: CueUse; cue: string } | null {
  if (!rule.ownedBy || !usage) return null;
  for (const [cue, uses] of usage) {
    for (const use of uses) {
      if (use.viewId === rule.ownedBy.viewId && use.objectId === rule.ownedBy.objectId) return { use, cue };
    }
  }
  return null;
}

/**
 * Which way an owned rule lost its Button: the Button is gone, or it still exists
 * and presses another command now. Null while the rule is held (the list route's
 * `ownerMissing` is the authority on that; this only says WHICH way).
 */
export function orphanKind(
  rule: RuleWithIssues,
  usage: ReadonlyMap<string, readonly CueUse[]> | undefined,
): OrphanKind | null {
  if (!rule.ownerMissing) return null;
  return ownerUse(rule, usage) ? "repointed" : "removed";
}

function locationOf(rule: RuleWithIssues): string {
  if (rule.action.id !== "companion.press") return "action";
  const p = rule.action.params;
  return `p${String(p.page)} r${String(p.row)} c${String(p.col)}`;
}

function titleOf(rule: RuleWithIssues): string {
  const label = rule.action.id === "companion.press" ? String(rule.action.params.label ?? "").trim() : "";
  return label || rule.name;
}

function OwnedRow({
  rule,
  usage,
  onChanged,
}: {
  rule: RuleWithIssues;
  usage: ReadonlyMap<string, readonly CueUse[]> | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const kind = orphanKind(rule, usage);
  const owner = ownerUse(rule, usage);
  const cue = calledCueName(rule.trigger);

  // The row says where the Button is while it is held, and what happened to it when it is not.
  let where: React.ReactNode;
  if (kind === "removed") {
    where = (
      <span data-owner-state="removed" className="inline-flex items-center rounded-[4px] border border-amber-7 px-1.5 text-caption2 leading-4 text-amber-11">
        Button removed
      </span>
    );
  } else if (kind === "repointed") {
    where = (
      <span data-owner-state="repointed" className="inline-flex items-center rounded-[4px] border border-amber-7 px-1.5 text-caption2 leading-4 text-amber-11">
        No longer used by its button
      </span>
    );
  } else {
    const name = owner ? owner.use.viewName : (rule.ownedBy?.viewId ?? "");
    const label = owner?.use.label ? ` · ${owner.use.label}` : "";
    where = (
      <>
        Belongs to{" "}
        <span data-owner-state="held" className="inline-flex items-center rounded-[4px] bg-fill px-1.5 text-caption2 leading-4 text-fg">
          {name}
          {label}
        </span>
      </>
    );
  }

  async function listIt() {
    setBusy(true);
    try {
      await invoke("automation:updateRule", { id: rule.id, patch: { ownedBy: null } });
    } catch (e) {
      toast.error(`Could not list ${cue || rule.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${titleOf(rule)}?`,
      message: `The command ${cue} goes with it. Anything calling that URL stops working.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await invoke("automation:removeRule", { id: rule.id });
    } catch (e) {
      toast.error(`Could not delete ${cue || rule.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div
      data-owned-rule={rule.id}
      className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
    >
      <span className="shrink-0 font-mono text-caption2 text-fg-subtle">{locationOf(rule)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-footnote font-medium text-fg">{titleOf(rule)}</span>
          <span className="min-w-0 truncate font-mono text-caption2 text-fg-subtle">{cue}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-caption1 text-fg-muted">{where}</div>
      </div>
      <Button variant="filled" size="small" disabled={busy} onClick={() => void listIt()}>
        List it with the other commands
      </Button>
      {kind !== null && (
        <Button
          variant="transparent"
          size="small"
          disabled={busy}
          aria-label={`Delete ${titleOf(rule)}`}
          onClick={() => void remove()}
        >
          <Trash2Icon className="size-3.5 text-red-10" /> Delete
        </Button>
      )}
    </div>
  );
}

/** The owned rules' rows, for the disclosure below and for Search. */
export function OwnedRows({
  rules,
  usage,
  onChanged,
}: {
  rules: readonly RuleWithIssues[];
  usage: ReadonlyMap<string, readonly CueUse[]> | undefined;
  onChanged: () => void;
}) {
  return (
    <>
      {rules.map((r) => (
        <OwnedRow key={r.id} rule={r} usage={usage} onChanged={onChanged} />
      ))}
    </>
  );
}

/**
 * The collapsed list of commands that belong to a Button. Renders nothing when no
 * rule is owned, so an install that never used a Button's own press does not see
 * an empty disclosure.
 */
export function BelongsToButton({
  rules,
  usage,
  onChanged,
}: {
  rules: readonly RuleWithIssues[];
  usage: ReadonlyMap<string, readonly CueUse[]> | undefined;
  onChanged: () => void;
}) {
  if (rules.length === 0) return null;
  return (
    <details className="group flex flex-col gap-1.5" data-belongs-to-button="">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-footnote font-semibold text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3 shrink-0 translate-y-0.5 text-fg-subtle transition-transform group-open:rotate-90" />
        Belongs to a button
        <span className="text-caption1 font-normal text-fg-muted">
          <span className="font-mono tabular-nums">{rules.length}</span> · made from a console or Home button, listed for the log
        </span>
      </summary>
      <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-surface">
        <OwnedRows rules={rules} usage={usage} onChanged={onChanged} />
      </div>
    </details>
  );
}
