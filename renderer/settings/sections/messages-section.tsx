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
// the page is behind (another window saved first, or this page's own save went
// through after its answer was lost): it reloads what is stored, says so, and
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

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";
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

/**
 * A row of an editable list: a box holding the text, saved when it loses focus,
 * and what can be done to the row. The quick lists add arrows (`onMove`); a group
 * adds how many screens are in it (`trailing`).
 */
function EditRow({
  text,
  editLabel,
  maxLength,
  onEdit,
  onMove,
  first,
  last,
  trailing,
  onRemove,
  groupId,
}: {
  text: string;
  /** What the box is called to a screen reader, before the text: "Edit", "Rename". */
  editLabel: string;
  maxLength: number;
  /** Resolves true when the save landed. */
  onEdit: (next: string) => Promise<boolean>;
  onMove?: (by: -1 | 1) => void;
  first?: boolean;
  last?: boolean;
  trailing?: ReactNode;
  onRemove: () => void;
  groupId?: string;
}) {
  const [draft, setDraft] = useState(text);
  // What the server holds changed under this row (a move, a save from another
  // tab): show it. A draft that failed to save is NOT reset by this, because
  // the stored text did not change.
  useResyncOn([text], () => setDraft(text));

  async function commit() {
    const next = draft.trim();
    // Unchanged is nothing to save. An emptied row is put back rather than
    // deleted: removing is the trash can.
    if (next === text || next === "") {
      setDraft(text);
      return;
    }
    await onEdit(next);
  }

  return (
    <li data-group-row={groupId} className="flex items-center gap-1.5">
      <Input
        value={draft}
        maxLength={maxLength}
        aria-label={`${editLabel} ${text}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(text);
        }}
      />
      {trailing}
      {onMove && (
        <>
          <Button variant="transparent" size="small" iconOnly disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${text} up`}>
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button variant="transparent" size="small" iconOnly disabled={last} onClick={() => onMove(1)} aria-label={`Move ${text} down`}>
            <ArrowDownIcon className="size-3.5" />
          </Button>
        </>
      )}
      <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label={`Remove ${text}`} className="text-danger-11">
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * The box under a list that adds to it, and how full the list is. It stays off
 * only while its own add is in flight, so a double click cannot add twice.
 */
function AddRow({
  noun,
  placeholder,
  maxLength,
  count,
  max,
  onAdd,
}: {
  /** One entry of the list, for the box's name: "quick message". */
  noun: string;
  placeholder: string;
  maxLength: number;
  count: number;
  max: number;
  /** Resolves true when the save landed, and the box is cleared. */
  onAdd: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const full = count >= max;

  async function add() {
    const next = text.trim();
    if (!next || full || pending) return;
    setPending(true);
    try {
      if (await onAdd(next)) setText("");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          maxLength={maxLength}
          disabled={pending || full}
          placeholder={full ? `At most ${max}` : placeholder}
          aria-label={`New ${noun}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Button variant="accent" size="small" disabled={pending || full || text.trim() === ""} onClick={() => void add()}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </div>
      <p className="text-caption2 text-fg-subtle">
        {count} of {max}
      </p>
    </>
  );
}

/** `current` has one of `texts` at `index`: a save queued behind another one may
 *  find the list has moved on, and acting on whatever is at that index now would
 *  change a row nobody clicked. */
function whereItIs(current: readonly string[], index: number, texts: readonly string[]): boolean {
  return texts.includes(current[index]);
}

function StringList({ label, noun, description, items, max, itemMax, placeholder, onChange }: StringListProps) {
  // What a row's edit that is still in flight will make it say, by index. A click
  // on its arrows or trash can while the edit saves names the text it shows now;
  // by the time that click's turn comes the row says the new text, and an action
  // that accepted only the old one would find nothing and do nothing.
  const editing = useRef(new Map<number, string>());
  /** The texts a click on row `index`, showing `text`, may find there when its turn comes. */
  const acceptable = (index: number, text: string): string[] => {
    const next = editing.current.get(index);
    return next === undefined ? [text] : [text, next];
  };

  async function edit(index: number, text: string, next: string): Promise<boolean> {
    editing.current.set(index, next);
    try {
      return await onChange((current) => (whereItIs(current, index, [text]) ? current.map((t, j) => (j === index ? next : t)) : null));
    } finally {
      if (editing.current.get(index) === next) editing.current.delete(index);
    }
  }

  function move(index: number, by: -1 | 1) {
    const texts = acceptable(index, items[index]);
    void onChange((current) => {
      if (!whereItIs(current, index, texts) || current[index + by] === undefined) return null;
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
          <EditRow
            // The index: a row's draft belongs to its place, and the text it
            // shows follows what the server holds there.
            key={i}
            text={text}
            editLabel="Edit"
            maxLength={itemMax}
            first={i === 0}
            last={i === items.length - 1}
            onEdit={(next) => edit(i, text, next)}
            onMove={(by) => move(i, by)}
            onRemove={() => {
              const texts = acceptable(i, text);
              void onChange((current) => (whereItIs(current, i, texts) ? current.filter((_, j) => j !== i) : null));
            }}
          />
        ))}
      </ul>
      {items.length === 0 && <p className="text-caption2 text-fg-subtle">None yet.</p>}
      <AddRow
        noun={noun}
        placeholder={placeholder}
        maxLength={itemMax}
        count={items.length}
        max={max}
        onAdd={(text) => onChange((current) => (current.length >= max ? null : [...current, text]))}
      />
    </div>
  );
}

/** How many screens are in a group; nothing until the screens are known, rather than 0. */
function ScreenCount({ screens }: { screens: number | null }) {
  return (
    <span className="w-20 shrink-0 text-caption2 text-fg-subtle">
      {screens === null ? "" : screens === 0 ? "no screens" : plural(screens, "screen")}
    </span>
  );
}

/**
 * `outputs` is undefined until the screens are known. The page does not wait for
 * them: they only supply the "N screens" beside a group, and a count that is not
 * known yet is left blank rather than drawn as 0.
 */
export function MessagesSection({
  outputs,
  onConfigSaved,
}: {
  outputs?: readonly Output[];
  /** Called when a save has changed the stored config, so anything else holding a
   *  copy (the rule editor's list of groups) can refetch it. */
  onConfigSaved?: () => void;
}) {
  const [config, setConfig] = useState<MessagingConfig | null>(null);
  const { failed, fail, clear } = useFailedReads<"config">("messages");

  // The config the next save is built from. State is what is drawn; this is what
  // is TRUE, and it moves the instant a save lands, before React has re-rendered.
  const latest = useRef<MessagingConfig | null>(null);
  // The end of the line of saves. Each one waits for the one before it.
  const line = useRef<Promise<unknown>>(Promise.resolve());

  const adopt = useCallback((next: MessagingConfig) => {
    latest.current = next;
    setConfig(next);
  }, []);

  /** Read the stored config. Resolves false when it could not be read. */
  const read = useCallback(
    // Never racing a save: it runs when the page has no config yet (the first
    // read, Try again), or inside the line of saves, which waits for it.
    (): Promise<boolean> =>
      invoke<MessagingConfig>("messaging:get").then(
        (stored) => {
          adopt(stored);
          clear("config");
          return true;
        },
        (err: unknown) => {
          fail("config", "the groups and quick messages", err);
          return false;
        },
      ),
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
        adopt(stored);
        clear("config");
        onConfigSaved?.();
        return true;
      } catch (err) {
        const { status, code } = err as ApiError;
        if (status === 409) {
          // Another window saved first. Nothing was changed; what it left is read
          // BEFORE the next queued save runs, or that one is refused the same way.
          // Another window saved first, or this page's own earlier save went through
          // after its answer was lost (a timeout): either way the page is behind.
          logToServer("messages", "the groups and quick messages changed since this page loaded; reloaded");
          toast.error("The groups and quick messages changed since this page loaded, so they have been reloaded. Make your change again.");
          await read();
          return false;
        }
        if (code === "groups-not-cleared") {
          // The config WAS saved; what failed is taking a deleted group off the
          // screens. The page's copy is out of date either way, and the message
          // already says that saving again retries.
          logToServer("messages", `the save landed but did not finish: ${errorMessage(err)}`);
          toast.error(errorMessage(err));
          await read();
          onConfigSaved?.();
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

  async function removeGroup(group: MessageGroup) {
    const n = screensIn(group.id);
    const message =
      n === null
        ? "Any screens in it will be taken out of it. Messages already sent to it stay in today's thread."
        : n === 0
          ? "No screens are in it. Messages already sent to it stay in today's thread."
          : `${plural(n, "screen is", "screens are")} in it, and will be taken out of it. Messages already sent to it stay in today's thread.`;
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
              <EditRow
                key={g.id}
                groupId={g.id}
                text={g.name}
                editLabel="Rename"
                maxLength={GROUP_NAME_MAX}
                onEdit={(name) =>
                  save((current) =>
                    current.groups.some((x) => x.id === g.id)
                      ? { groups: current.groups.map((x) => (x.id === g.id ? { id: x.id, name } : x)) }
                      : null,
                  )
                }
                trailing={<ScreenCount screens={screensIn(g.id)} />}
                onRemove={() => void removeGroup(g)}
              />
            ))}
          </ul>
          {config.groups.length === 0 && <p className="text-caption2 text-fg-subtle">No groups yet.</p>}
          <AddRow
            noun="group"
            placeholder="New group"
            maxLength={GROUP_NAME_MAX}
            count={config.groups.length}
            max={GROUPS_MAX}
            onAdd={(name) => save((current) => ({ groups: [...current.groups, { name }] }))}
          />
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
