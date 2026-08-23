// tag-picker.tsx — pick signage tags, and name a new one without leaving.
//
// There is no page for administering tags, which is the point: they are assigned
// where the work is. That only holds if a tag can be CREATED there too —
// otherwise "put this screen in a new set" still means going somewhere else to
// make the set first, and the page we deleted grows back as a detour.
//
// Naming happens inline rather than through window.prompt(). A prompt is a
// browser dialog wearing the browser's clothes, it cannot be styled to look like
// the app it interrupts, and some contexts refuse to show one at all — which
// would be a "New tag…" button that silently did nothing.

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import type { SignageGroup } from "@main/types/signage";

import { Input } from "../../components/ui/input";
import { MultiSelect } from "../../components/ui/multi-select";

/** Past this many, the picker gets a search field. */
const SEARCHABLE_FROM = 8;

export function TagPicker({
  groups,
  selected,
  onChange,
  onCreate,
  placeholder = "No tags",
  summary,
  className,
}: {
  groups: SignageGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Make a tag and return its id. Null when it could not be made. */
  onCreate: (name: string) => Promise<string | null>;
  placeholder?: string;
  summary?: string;
  className?: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await onCreate(trimmed);
      // Selected straight away. Making a tag from inside a picker and then
      // having to find and tick it is the detour this exists to remove.
      if (id) onChange([...selected, id]);
      setName("");
      setNaming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MultiSelect
      options={groups.map((g) => ({ value: g.id, label: g.name }))}
      selected={selected}
      onChange={onChange}
      placeholder={placeholder}
      summary={summary}
      className={className}
      searchable={groups.length > SEARCHABLE_FROM}
      footer={
        naming ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name the tag"
            aria-label="Name the new tag"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // Stop here rather than letting the popover close as well: the
                // first Escape means "not this tag", not "not this picker".
                e.stopPropagation();
                setNaming(false);
                setName("");
              }
            }}
            // Committed on blur too, so clicking away from a typed name keeps it
            // rather than throwing it out.
            onBlur={() => void create()}
            className="h-7 text-footnote"
          />
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-footnote text-accent outline-none hover:bg-fill focus-visible:bg-fill"
          >
            <PlusIcon className="size-3.5" />
            New tag…
          </button>
        )
      }
    />
  );
}
