// new-screen-dialog.tsx — what kind of screen is this?
//
// Asked at the moment a screen is made, because that is when the operator knows
// the answer: they are adding it because a monitor went up somewhere and they
// know what it is for.
//
// It replaces "turn a screen into a signage screen", which was a button on the
// signage Groups page — so making a foyer TV meant adding a screen here, going
// to another tab, finding it in a list of everything that was NOT signage, and
// converting it. The screen existed in the wrong state in between, and the list
// it appeared in was defined by what it wasn't.

import { useState } from "react";
import { LayoutDashboardIcon, MonitorPlayIcon, SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogRoot,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

/** What the screen is for. Maps onto an output mode plus a view kind — see
 *  createScreen in use-stage-settings, which is the only place that mapping
 *  lives. */
export type ScreenKind = "kiosk" | "signage" | "console";

const KINDS: {
  value: ScreenKind;
  label: string;
  hint: string;
  icon: typeof MonitorPlayIcon;
}[] = [
  {
    value: "kiosk",
    label: "Kiosk",
    hint: "A wall screen showing a view you build — mic slots, a dashboard, a stage display.",
    icon: LayoutDashboardIcon,
  },
  {
    value: "signage",
    label: "Signage",
    hint: "Graphics and video on a schedule. Set up under Signage.",
    icon: MonitorPlayIcon,
  },
  {
    value: "console",
    label: "Console",
    hint: "A touchscreen somebody operates. Buttons work; it is not a read-only display.",
    icon: SlidersHorizontalIcon,
  },
];

export function NewScreenDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (kind: ScreenKind, name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ScreenKind>("kiosk");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setKind("kiosk");
      setName("");
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await onCreate(kind, name.trim());
      close(false);
    } catch {
      // Stay OPEN, keeping what they typed. The handler has already toasted the
      // reason; closing as well would make them type the name again to find out
      // whether it works the second time. Not rethrown: there is no caller above
      // this to tell, and the operator has been told.
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a screen</DialogTitle>
          <DialogDescription>
            What is this one for? It can be changed afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {KINDS.map((k) => {
            const Icon = k.icon;
            const on = kind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(k.value)}
                className={
                  on
                    ? "flex items-start gap-3 rounded-lg border-2 border-accent bg-fill p-3 text-left"
                    : "flex items-start gap-3 rounded-lg border-2 border-line p-3 text-left transition-colors hover:bg-fill-hover"
                }
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-footnote font-medium text-fg">{k.label}</span>
                  <span className="text-caption2 text-fg-subtle">{k.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-caption1 text-fg-muted">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Foyer north"
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          {/* Disabled while creating: cancelling mid-write would close the
              dialog over a screen that is being made anyway. */}
          <Button disabled={busy} onClick={() => close(false)}>Cancel</Button>
          <Button variant="accent" disabled={busy} onClick={() => void create()}>
            Add screen
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
