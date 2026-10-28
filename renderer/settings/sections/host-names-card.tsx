// host-names-card.tsx — Settings, Advanced: the names this server answers to.
//
// The defence against DNS rebinding (main/services/host-names.ts). Names that
// reached the server and are not on the list wait here to be accepted or
// dismissed; the rail counts them. The add field validates with the server's own
// rules (host-name-rules.ts), so it never offers what the server would refuse.

import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { CheckIcon, Trash2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { listableName } from "@main/services/host-name-rules";
import type { AcceptedSource, HostNamesView } from "@main/services/host-names";
import { plural } from "@main/services/plural";

import { Button, Input, Switch, toast } from "../../components/ui";
import { useHostNames, useHostNamesChange } from "../../app/host-names-query";
import { settingText, type AdvancedSettingId } from "./advanced-settings";

const SOURCE_LABEL: Record<AcceptedSource | HostNamesView["automatic"][number]["source"], string> = {
  machine: "This machine",
  "public-address": "Public address",
  added: "Added",
  accepted: "Accepted",
  seen: "Seen, 30 days",
};

/** What the add field says under itself: why a name cannot be added, or what a pasted address adds. */
function hintFor(draft: string): string {
  const typed = draft.trim();
  if (!typed) return "";
  const parsed = listableName(typed);
  if (!parsed.ok) return parsed.error;
  if (parsed.name !== typed.toLowerCase()) return `Adds ${parsed.name}`;
  return "";
}

/** One name in a list: the name, then whatever acts on it. */
function NameRow({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line py-1 last:border-0">
      <span className="min-w-0 flex-1 truncate font-mono text-caption1 text-fg">{name}</span>
      {children}
    </div>
  );
}

function SourceTag({ source }: { source: keyof typeof SOURCE_LABEL }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-line-strong px-1.5 py-0.5 text-caption2 text-fg-muted">
      {SOURCE_LABEL[source]}
    </span>
  );
}

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "";
}

/**
 * `title` replaces the card's heading (the Search tab names the tab it came from),
 * and `show` narrows the card to the rows a search matched; both default to the
 * card as it sits on the Network tab.
 */
export function HostNamesCard({
  title = "Host names",
  show = () => true,
}: {
  title?: ReactNode;
  show?: (id: AdvancedSettingId) => boolean;
} = {}) {
  const { data, error } = useHostNames();
  const change = useHostNamesChange();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  /** One change; true when the server took it, false when it said why not (toasted). */
  async function send(body: Record<string, unknown>, done?: string): Promise<boolean> {
    setBusy(true);
    try {
      await change(body);
      if (done) toast.success(done);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const parsed = listableName(draft);
  const hint = hintFor(draft);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.ok) return;
    void send({ add: parsed.name }, `Added ${parsed.name}`).then((added) => {
      if (added) setDraft("");
    });
  }

  const enforceText = settingText("host-names-enforce");
  const listText = settingText("host-names-list");
  const enforce = data?.enforce ?? false;
  const waiting = data?.waiting ?? [];
  const automatic = data?.automatic ?? [];
  const accepted = data?.accepted ?? [];
  const dismissed = data?.dismissed ?? [];

  return (
    <div className="su-card">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-callout font-semibold text-fg">{title}</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2 py-0.5 text-caption1 text-fg-muted">
          <span className={`inline-block size-2 rounded-full ${enforce ? "bg-ok-9" : "bg-warn-9"}`} />
          {enforce ? "Refusing other names" : "Warn only"}
        </span>
      </div>

      {error && <p className="px-4 py-3 text-caption1 text-danger-11">Could not read the host names: {errorMessage(error)}</p>}

      <div className="divide-y divide-gray-a4">
        {show("host-names-enforce") && (
        <div
          className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
          data-setting-id="host-names-enforce"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-footnote font-medium leading-tight text-fg">{enforceText.name}</span>
            <span className="mt-0.5 text-caption2 leading-tight text-fg-subtle">{enforceText.description}</span>
            {/* What turning it on does depends on whether the list was already seeded. */}
            {!enforce && data?.seeded && (
              <span className="mt-0.5 text-caption2 leading-tight text-fg-subtle">
                The list is already seeded, so turning it on again accepts nothing new: accept the names you want first.
              </span>
            )}
          </div>
          <Switch
            checked={enforce}
            disabled={busy || !data}
            onCheckedChange={(on) => void send({ enforce: on })}
            aria-label="Refuse names not on the list"
          />
        </div>
        )}

        {show("host-names-list") && waiting.length > 0 && (
          <div className="px-4 py-3">
            <div
              className={`flex flex-col gap-1.5 rounded-md border p-2 ${enforce ? "border-red-6 bg-red-3/60" : "border-amber-6 bg-amber-2/60"}`}
            >
              <span className="text-caption1 font-medium text-fg">
                {plural(waiting.length, "name")} reached this server and {waiting.length === 1 ? "is" : "are"} not on the list
                {enforce ? ", and refused" : ""}
              </span>
              <span className="text-caption1 text-fg-muted">
                Accept the ones your screens, panels and Home Assistant use. Dismiss anything you do not recognise: it is
                never accepted on its own.
              </span>
              {waiting.map((s) => (
                <div key={s.name} className="flex items-center gap-2 border-t border-line pt-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-caption1 text-fg">{s.name}</span>
                    <span className="block text-caption2 text-fg-subtle">
                      {plural(s.count, "request")} · last {when(s.lastSeen)} from {s.lastFrom} · {s.client}
                    </span>
                  </span>
                  <Button variant="accent" size="small" disabled={busy} onClick={() => void send({ accept: s.name })}>
                    <CheckIcon className="size-3.5" /> Accept
                  </Button>
                  <Button variant="transparent" size="small" disabled={busy} onClick={() => void send({ dismiss: s.name })}>
                    Dismiss
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {show("host-names-list") && (
        <div className="flex flex-col gap-1.5 px-4 py-3" data-setting-id="host-names-list">
          <span className="text-footnote font-medium leading-tight text-fg">{listText.name}</span>
          <span className="text-caption2 leading-tight text-fg-subtle">{listText.description}</span>
          <div>
            {automatic.map((a) => (
              <NameRow key={a.name} name={a.name}>
                <SourceTag source={a.source} />
                <span className="inline-block size-6" aria-hidden="true" />
              </NameRow>
            ))}
            {accepted.map((a) => (
              <NameRow key={a.name} name={a.name}>
                <SourceTag source={a.source} />
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  disabled={busy}
                  aria-label={`Remove ${a.name}`}
                  onClick={() => void send({ remove: a.name })}
                >
                  <Trash2Icon className="size-3.5 text-red-10" />
                </Button>
              </NameRow>
            ))}
          </div>
          <form className="flex items-center gap-2" onSubmit={submit} noValidate>
            <Input
              value={draft}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
              placeholder="Add a name, e.g. stage.example.org"
              aria-label="Add a host name"
              aria-invalid={draft.trim() !== "" && !parsed.ok}
              autoComplete="off"
              spellCheck={false}
              className="h-7 flex-1 text-footnote"
            />
            <Button type="submit" variant="filled" size="small" disabled={busy || !parsed.ok}>
              Add
            </Button>
          </form>
          {hint && <span className="text-caption2 text-fg-subtle" aria-live="polite">{hint}</span>}
        </div>
        )}

        {show("host-names-list") && dismissed.length > 0 && (
          <div className="flex flex-col gap-1 px-4 py-3">
            <span className="text-footnote font-medium leading-tight text-fg">Dismissed</span>
            <span className="text-caption2 leading-tight text-fg-subtle">
              Never accepted on their own, including when refusal turns on.
            </span>
            {dismissed.map((d) => (
              <NameRow key={d.name} name={d.name}>
                <Button variant="transparent" size="small" disabled={busy} onClick={() => void send({ undismiss: d.name })}>
                  Undo
                </Button>
              </NameRow>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
