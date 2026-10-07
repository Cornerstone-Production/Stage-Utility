// messages-section.tsx — Settings -> Messages: the groups of screens a stage
// message can go to, and the one-press messages and replies a console offers.
//
// Saved through one call. The server takes all three lists at once and answers
// with what it stored, so a new group comes back with the id the server gave it
// and a refusal says which limit was broken. Every edit is one save; while one is
// in flight the controls are off, because the second would be built from the
// list the first is about to replace.
//
// A save that fails toasts, says so on /log, and KEEPS what was typed: a name
// that the server refused is still in its box to fix, not gone.
//
// A read that fails draws an error and no editor. Showing an empty list in its
// place and letting the operator add to it would save a list that holds only
// what they just typed, over the groups and replies they cannot see.

import { useCallback, useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import {
  GROUP_NAME_MAX,
  GROUPS_MAX,
  MESSAGE_MAX,
  QUICK_MESSAGES_MAX,
  QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX,
  type MessageGroup,
  type MessagingConfig,
} from "@main/types/messages";
import { Button, ErrorNote, Input, confirm, toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { useFailedReads } from "../../lib/use-failed-reads";
import { useResyncOn } from "../../lib/use-resync-on";

/** What the server takes: a group the server has not met carries no id. */
type ConfigBody = {
  groups: { id?: string; name: string }[];
  quickMessages: string[];
  quickReplies: string[];
};

/** The two lists of plain text share one editor. */
interface StringListProps {
  /** The list's name as a heading and a test id: "Quick messages". */
  label: string;
  /** One entry of it, for the add box: "quick message". */
  noun: string;
  description: string;
  items: readonly string[];
  max: number;
  itemMax: number;
  placeholder: string;
  busy: boolean;
  /** Resolves true when the save landed. */
  onChange: (next: string[]) => Promise<boolean>;
}

/** A row of an editable list: the text, and what can be done to it. */
function ListRow({
  text,
  first,
  last,
  itemMax,
  busy,
  onEdit,
  onMove,
  onRemove,
}: {
  text: string;
  first: boolean;
  last: boolean;
  itemMax: number;
  busy: boolean;
  onEdit: (next: string) => Promise<boolean>;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(text);
  // What the server holds changed under this row (a move, a save from another
  // tab): show it. A draft that failed to save is NOT reset by this, because
  // the stored text did not change.
  useResyncOn([text], () => setDraft(text));

  async function commit() {
    const next = draft.trim();
    if (next === text) {
      setDraft(text);
      return;
    }
    // An emptied row is put back rather than deleted: removing is the trash can.
    if (next === "") {
      setDraft(text);
      return;
    }
    await onEdit(next);
  }

  return (
    <li className="flex items-center gap-1.5">
      <Input
        value={draft}
        maxLength={itemMax}
        disabled={busy}
        aria-label={`Edit ${text}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(text);
        }}
      />
      <Button variant="transparent" size="small" iconOnly disabled={busy || first} onClick={() => onMove(-1)} aria-label={`Move ${text} up`}>
        <ArrowUpIcon className="size-3.5" />
      </Button>
      <Button variant="transparent" size="small" iconOnly disabled={busy || last} onClick={() => onMove(1)} aria-label={`Move ${text} down`}>
        <ArrowDownIcon className="size-3.5" />
      </Button>
      <Button variant="transparent" size="small" iconOnly disabled={busy} onClick={onRemove} aria-label={`Remove ${text}`} className="text-danger-11">
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

function StringList({ label, noun, description, items, max, itemMax, placeholder, busy, onChange }: StringListProps) {
  const [adding, setAdding] = useState("");
  const full = items.length >= max;

  async function add() {
    const text = adding.trim();
    if (!text || full) return;
    if (await onChange([...items, text])) setAdding("");
  }

  function move(index: number, by: -1 | 1) {
    const next = [...items];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    void onChange(next);
  }

  return (
    <div data-testid={`messages-${label.toLowerCase().replace(/\s+/g, "-")}`} className="flex flex-col gap-2 px-4 pb-4 pt-3">
      <p className="text-caption2 text-fg-subtle">{description}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((text, i) => (
          <ListRow
            // The index: a row's draft belongs to its place, and the text it
            // shows follows what the server holds there.
            key={i}
            text={text}
            first={i === 0}
            last={i === items.length - 1}
            itemMax={itemMax}
            busy={busy}
            onEdit={(next) => onChange(items.map((t, j) => (j === i ? next : t)))}
            onMove={(by) => move(i, by)}
            onRemove={() => void onChange(items.filter((_, j) => j !== i))}
          />
        ))}
      </ul>
      {items.length === 0 && <p className="text-caption2 text-fg-subtle">None yet.</p>}
      <div className="flex items-center gap-2">
        <Input
          value={adding}
          maxLength={itemMax}
          disabled={busy || full}
          placeholder={full ? `At most ${max}` : placeholder}
          aria-label={`New ${noun}`}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Button variant="accent" size="small" disabled={busy || full || adding.trim() === ""} onClick={() => void add()}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </div>
      <p className="text-caption2 text-fg-subtle">
        {items.length} of {max}
      </p>
    </div>
  );
}

function GroupRow({
  group,
  screens,
  busy,
  onRename,
  onRemove,
}: {
  group: MessageGroup;
  screens: number;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(group.name);
  useResyncOn([group.name], () => setDraft(group.name));

  async function commit() {
    const next = draft.trim();
    if (next === group.name || next === "") {
      setDraft(group.name);
      return;
    }
    await onRename(next);
  }

  return (
    <li data-group-row={group.id} className="flex items-center gap-1.5">
      <Input
        value={draft}
        maxLength={GROUP_NAME_MAX}
        disabled={busy}
        aria-label={`Rename ${group.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(group.name);
        }}
      />
      <span className="w-20 shrink-0 text-caption2 text-fg-subtle">
        {screens === 0 ? "no screens" : screens === 1 ? "1 screen" : `${screens} screens`}
      </span>
      <Button variant="transparent" size="small" iconOnly disabled={busy} onClick={onRemove} aria-label={`Remove ${group.name}`} className="text-danger-11">
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

export function MessagesSection({ outputs }: { outputs: readonly Output[] }) {
  const [config, setConfig] = useState<MessagingConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const { failed, fail, clear } = useFailedReads<"config">("messages");

  const load = useCallback(() => {
    let cancelled = false;
    invoke<MessagingConfig>("messaging:get")
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        clear("config");
      })
      .catch((err: unknown) => {
        if (!cancelled) fail("config", "the groups and quick messages", err);
      });
    return () => {
      cancelled = true;
    };
  }, [fail, clear]);
  useEffect(() => load(), [load]);

  /** Save the whole config. Resolves true when it landed; on a refusal the
   *  reason is toasted and logged and the caller keeps what it had typed. */
  async function persist(next: ConfigBody): Promise<boolean> {
    setSaving(true);
    try {
      setConfig(await invoke<MessagingConfig>("messaging:set", next));
      clear("config");
      return true;
    } catch (err) {
      logToServer("messages", `could not save the groups and quick messages: ${errorMessage(err)}`);
      toast.error(`Couldn't save that: ${errorMessage(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return failed.has("config") ? (
      <div className="flex flex-col items-start gap-2 pt-5">
        <ErrorNote>Couldn't load the groups and quick messages.</ErrorNote>
        <Button variant="filled" size="small" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="pt-5 text-footnote text-fg-subtle">Loading...</p>
    );
  }

  const body = (over: Partial<ConfigBody>): ConfigBody => ({
    groups: config.groups,
    quickMessages: config.quickMessages,
    quickReplies: config.quickReplies,
    ...over,
  });
  const screensIn = (id: string) => outputs.filter((o) => o.groups?.includes(id)).length;

  async function addGroup() {
    const name = newGroup.trim();
    if (!name || !config) return;
    if (await persist(body({ groups: [...config.groups, { name }] }))) setNewGroup("");
  }

  async function removeGroup(group: MessageGroup) {
    const n = screensIn(group.id);
    const message =
      n === 0
        ? "No screens are in it. Messages already sent to it stay in today's thread."
        : `${n} screen${n === 1 ? " is" : "s are"} in it, and will be taken out of it. Messages already sent to it stay in today's thread.`;
    if (!(await confirm({ title: `Remove ${group.name}?`, message, confirmLabel: "Remove", destructive: true }))) return;
    await persist(body({ groups: config!.groups.filter((g) => g.id !== group.id) }));
  }

  return (
    <div className="flex flex-col gap-4 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <div className="su-card" data-testid="messages-groups">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-callout font-semibold text-fg">Groups</h3>
        </div>
        <div className="flex flex-col gap-2 px-4 pb-4 pt-3">
          <p className="text-caption2 text-fg-subtle">
            A group is a set of screens that gets a message together: Green room, Stage, Booth. Put a screen in groups
            from its menu on the Screens page. Everyone is built in and reaches every screen.
          </p>
          <ul className="flex flex-col gap-1.5">
            {config.groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                screens={screensIn(g.id)}
                busy={saving}
                onRename={(name) => persist(body({ groups: config.groups.map((x) => (x.id === g.id ? { id: x.id, name } : x)) }))}
                onRemove={() => void removeGroup(g)}
              />
            ))}
          </ul>
          {config.groups.length === 0 && <p className="text-caption2 text-fg-subtle">No groups yet.</p>}
          <div className="flex items-center gap-2">
            <Input
              value={newGroup}
              maxLength={GROUP_NAME_MAX}
              disabled={saving || config.groups.length >= GROUPS_MAX}
              placeholder={config.groups.length >= GROUPS_MAX ? `At most ${GROUPS_MAX}` : "Green room"}
              aria-label="New group"
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGroup();
              }}
            />
            <Button
              variant="accent"
              size="small"
              disabled={saving || config.groups.length >= GROUPS_MAX || newGroup.trim() === ""}
              onClick={() => void addGroup()}
            >
              <PlusIcon className="size-3.5" /> Add
            </Button>
          </div>
          <p className="text-caption2 text-fg-subtle">
            {config.groups.length} of {GROUPS_MAX}
          </p>
        </div>
      </div>

      <div className="su-card">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-callout font-semibold text-fg">Quick messages</h3>
        </div>
        <StringList
          label="Quick messages"
          noun="quick message"
          description="Messages a console can send in one press."
          items={config.quickMessages}
          max={QUICK_MESSAGES_MAX}
          itemMax={MESSAGE_MAX}
          placeholder="Walk now"
          busy={saving}
          onChange={(next) => persist(body({ quickMessages: next }))}
        />
      </div>

      <div className="su-card">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-callout font-semibold text-fg">Quick replies</h3>
        </div>
        <StringList
          label="Quick replies"
          noun="quick reply"
          description="Answers a console can send in one press to a message."
          items={config.quickReplies}
          max={QUICK_REPLIES_MAX}
          itemMax={QUICK_REPLY_MAX}
          placeholder="Copy"
          busy={saving}
          onChange={(next) => persist(body({ quickReplies: next }))}
        />
      </div>
    </div>
  );
}
