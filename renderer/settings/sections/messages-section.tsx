// messages-section.tsx — Settings -> Messages: the groups of screens a stage
// message can go to, and the one-press messages and replies a console offers.
//
// Saved through one call. The server takes all three lists at once and answers
// with what it stored, so a new group comes back with the id the server gave it
// and a refusal says which limit was broken. Every edit is one save, and saves
// run one after another: each is worked out from the config the one before it
// left, when its turn comes, not from the page as it was drawn when the click
// happened. The controls stay on meanwhile, so a click on another row's button
// that blurred a box (and so started a save) is not lost to a disabled button.
//
// A save that fails toasts, says so on /log, and KEEPS what was typed: a name
// that the server refused is still in its box to fix, not gone.
//
// Every save carries the version of the config it was built from. A 409 means
// another window saved first: this one reloads what is stored, says so, and
// saves nothing, because the whole config is replaced at once and a save built
// from the old one would delete what the other window added.
//
// A save the server made but could not finish (taking a deleted group off the
// screens) answers 500 with code groups-not-cleared: the page reloads what is
// stored and shows the server's message, which says that saving again retries.
//
// A read that fails draws an error and no editor. Showing an empty list in its
// place and letting the operator add to it would save a list that holds only
// what they just typed, over the groups and replies they cannot see.

import { useCallback, useEffect, useRef, useState } from "react";
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
import { invoke, type ApiError } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { useFailedReads } from "../../lib/use-failed-reads";
import { useResyncOn } from "../../lib/use-resync-on";

/** What a save changes: any of the three lists, worked out from the config it is
 *  applied to. A group the server has not met carries no id. */
type ConfigChange = {
  groups?: { id?: string; name: string }[];
  quickMessages?: string[];
  quickReplies?: string[];
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
  /** Resolves true when the save landed. `update` is given the list as it stands
   *  when this save's turn comes, and returns the new one, or null when what was
   *  asked for no longer applies (the row it named has since moved). */
  onChange: (update: (current: readonly string[]) => string[] | null) => Promise<boolean>;
}

/** A row of an editable list: the text, and what can be done to it. */
function ListRow({
  text,
  first,
  last,
  itemMax,
  onEdit,
  onMove,
  onRemove,
}: {
  text: string;
  first: boolean;
  last: boolean;
  itemMax: number;
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
        aria-label={`Edit ${text}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(text);
        }}
      />
      <Button variant="transparent" size="small" iconOnly disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${text} up`}>
        <ArrowUpIcon className="size-3.5" />
      </Button>
      <Button variant="transparent" size="small" iconOnly disabled={last} onClick={() => onMove(1)} aria-label={`Move ${text} down`}>
        <ArrowDownIcon className="size-3.5" />
      </Button>
      <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label={`Remove ${text}`} className="text-danger-11">
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

/** `current` with the entry at `index` replaced, moved or dropped, but only if it
 *  still holds `text`: a save queued behind another one may find the list has
 *  moved on, and acting on whatever is at that index now would change a row
 *  nobody clicked. */
function whereItIs(current: readonly string[], index: number, text: string): boolean {
  return current[index] === text;
}

function StringList({ label, noun, description, items, max, itemMax, placeholder, onChange }: StringListProps) {
  const [adding, setAdding] = useState("");
  // Only the add box stays off while its own add is in flight, so a double click
  // cannot add the same entry twice.
  const [pending, setPending] = useState(false);
  const full = items.length >= max;

  async function add() {
    const text = adding.trim();
    if (!text || full || pending) return;
    setPending(true);
    try {
      if (await onChange((current) => (current.length >= max ? null : [...current, text]))) setAdding("");
    } finally {
      setPending(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    const text = items[index];
    void onChange((current) => {
      if (!whereItIs(current, index, text) || current[index + by] === undefined) return null;
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });
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
            onEdit={(next) => onChange((current) => (whereItIs(current, i, text) ? current.map((t, j) => (j === i ? next : t)) : null))}
            onMove={(by) => move(i, by)}
            onRemove={() => void onChange((current) => (whereItIs(current, i, text) ? current.filter((_, j) => j !== i) : null))}
          />
        ))}
      </ul>
      {items.length === 0 && <p className="text-caption2 text-fg-subtle">None yet.</p>}
      <div className="flex items-center gap-2">
        <Input
          value={adding}
          maxLength={itemMax}
          disabled={pending || full}
          placeholder={full ? `At most ${max}` : placeholder}
          aria-label={`New ${noun}`}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Button variant="accent" size="small" disabled={pending || full || adding.trim() === ""} onClick={() => void add()}>
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
  onRename,
  onRemove,
}: {
  group: MessageGroup;
  /** Null until the Screens are known: the count is left off rather than drawn as 0. */
  screens: number | null;
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
        aria-label={`Rename ${group.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(group.name);
        }}
      />
      <span className="w-20 shrink-0 text-caption2 text-fg-subtle">
        {screens === null ? "" : screens === 0 ? "no screens" : screens === 1 ? "1 screen" : `${screens} screens`}
      </span>
      <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label={`Remove ${group.name}`} className="text-danger-11">
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * `outputs` is undefined until the screens are known. The page does not wait for
 * them: they only supply the "N screens" beside a group, and a count that is not
 * known yet is left blank rather than drawn as 0.
 */
export function MessagesSection({ outputs }: { outputs?: readonly Output[] }) {
  const [config, setConfig] = useState<MessagingConfig | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const { failed, fail, clear } = useFailedReads<"config">("messages");

  // The config the next save is built from. State is what is drawn; this is what
  // is TRUE, and it moves the instant a save lands, before React has re-rendered.
  const latest = useRef<MessagingConfig | null>(null);
  // The end of the line of saves. Each one waits for the one before it.
  const line = useRef<Promise<unknown>>(Promise.resolve());
  // Bumped by every save that lands. A read that was already on its way when one
  // did is older than what the page holds, and is dropped.
  const epoch = useRef(0);

  const adopt = useCallback((next: MessagingConfig) => {
    latest.current = next;
    setConfig(next);
  }, []);

  /** Read the stored config. Resolves false when it could not be read. */
  const read = useCallback(
    (): Promise<boolean> => {
      const started = epoch.current;
      return invoke<MessagingConfig>("messaging:get").then(
        (stored) => {
          if (epoch.current === started) adopt(stored);
          clear("config");
          return true;
        },
        (err: unknown) => {
          fail("config", "the groups and quick messages", err);
          return false;
        },
      );
    },
    [adopt, fail, clear],
  );
  useEffect(() => {
    void read();
  }, [read]);

  /**
   * Save a change to the config, after every save before it. `change` is given the
   * config as it stands when this one's turn comes and returns what to replace
   * (null: nothing, the thing it named is gone). Resolves true when it landed; on
   * a refusal the reason is toasted and logged and the caller keeps what it typed.
   */
  function save(change: (current: MessagingConfig) => ConfigChange | null): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const current = latest.current;
      const replaced = current && change(current);
      if (!current || !replaced) return false;
      try {
        const stored = await invoke<MessagingConfig>("messaging:set", {
          version: current.version,
          groups: current.groups,
          quickMessages: current.quickMessages,
          quickReplies: current.quickReplies,
          ...replaced,
        });
        epoch.current++;
        adopt(stored);
        clear("config");
        return true;
      } catch (err) {
        const { status, code } = err as ApiError;
        if (status === 409) {
          // Another window saved first. Nothing was changed; what it left is read
          // BEFORE the next queued save runs, or that one is refused the same way.
          logToServer("messages", "the groups and quick messages changed in another window; reloaded");
          toast.error("The groups and quick messages were changed in another window. They have been reloaded; make your change again.");
          await read();
          return false;
        }
        if (code === "groups-not-cleared") {
          // The config WAS saved; what failed is taking a deleted group off the
          // screens. The page's copy is out of date either way, and the message
          // already says that saving again retries.
          logToServer("messages", `saved the groups, but ${errorMessage(err)}`);
          toast.error(errorMessage(err));
          await read();
          return true;
        }
        logToServer("messages", `could not save the groups and quick messages: ${errorMessage(err)}`);
        toast.error(`Couldn't save that: ${errorMessage(err)}`);
        return false;
      }
    };
    const result = line.current.then(run);
    // run() answers every failure itself, so the line never holds a rejection.
    line.current = result;
    return result;
  }

  if (!config) {
    return failed.has("config") ? (
      <div className="flex flex-col items-start gap-2 pt-5">
        <ErrorNote>Couldn't load the groups and quick messages.</ErrorNote>
        <Button variant="filled" size="small" onClick={() => void read()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="pt-5 text-footnote text-fg-subtle">Loading...</p>
    );
  }

  const screensIn = (id: string): number | null => (outputs ? outputs.filter((o) => o.groups?.includes(id)).length : null);

  async function addGroup() {
    const name = newGroup.trim();
    if (!name || addingGroup) return;
    setAddingGroup(true);
    try {
      if (await save((current) => ({ groups: [...current.groups, { name }] }))) setNewGroup("");
    } finally {
      setAddingGroup(false);
    }
  }

  async function removeGroup(group: MessageGroup) {
    const n = screensIn(group.id);
    const message =
      n === null
        ? "Any screens in it will be taken out of it. Messages already sent to it stay in today's thread."
        : n === 0
          ? "No screens are in it. Messages already sent to it stay in today's thread."
          : `${n} screen${n === 1 ? " is" : "s are"} in it, and will be taken out of it. Messages already sent to it stay in today's thread.`;
    if (!(await confirm({ title: `Remove ${group.name}?`, message, confirmLabel: "Remove", destructive: true }))) return;
    await save((current) => (current.groups.some((g) => g.id === group.id) ? { groups: current.groups.filter((g) => g.id !== group.id) } : null));
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
                onRename={(name) =>
                  save((current) =>
                    current.groups.some((x) => x.id === g.id)
                      ? { groups: current.groups.map((x) => (x.id === g.id ? { id: x.id, name } : x)) }
                      : null,
                  )
                }
                onRemove={() => void removeGroup(g)}
              />
            ))}
          </ul>
          {config.groups.length === 0 && <p className="text-caption2 text-fg-subtle">No groups yet.</p>}
          <div className="flex items-center gap-2">
            <Input
              value={newGroup}
              maxLength={GROUP_NAME_MAX}
              disabled={addingGroup || config.groups.length >= GROUPS_MAX}
              placeholder={config.groups.length >= GROUPS_MAX ? `At most ${GROUPS_MAX}` : "New group"}
              aria-label="New group"
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGroup();
              }}
            />
            <Button
              variant="accent"
              size="small"
              disabled={addingGroup || config.groups.length >= GROUPS_MAX || newGroup.trim() === ""}
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
          placeholder="New quick message"
          onChange={(update) =>
            save((current) => {
              const quickMessages = update(current.quickMessages);
              return quickMessages && { quickMessages };
            })
          }
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
          placeholder="New quick reply"
          onChange={(update) =>
            save((current) => {
              const quickReplies = update(current.quickReplies);
              return quickReplies && { quickReplies };
            })
          }
        />
      </div>
    </div>
  );
}
