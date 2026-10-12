// The small parts the settings panel's three bodies share: a section, a field,
// a switch row, the view picker, a choice card and the line that says what a
// screen is. Kept apart from the panel so the screen body, the view body and the
// new-screen body can each live in a file of their own without importing the
// panel back.

import type { ChangeEvent, ReactNode } from "react";

import { Button, Input, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue, Switch, type ButtonProps } from "../../components/ui";
import { cn } from "../../lib/cn";
import { viewSurface, type ViewSurface } from "@main/types/views";
import { SURFACE_COPY } from "../screen-role-confirm";

/** Select sentinels. Never stored: one clears the view, the others ask for a new one. */
export const NONE = "__none__";
export const NEW_WALL = "__new_wall__";
export const NEW_CONTROL = "__new_control__";

/** The views a picker offers, split the way the picker groups them. */
export function viewGroups(views: readonly View[]): { label: string; views: View[] }[] {
  return [
    { label: "Wall views", views: views.filter((v) => viewSurface(v) === "display") },
    { label: "Control surfaces", views: views.filter((v) => viewSurface(v) === "console") },
  ];
}

/**
 * Names, quoted, for a sentence about screens or views: one, two joined by "and",
 * three or more separated by commas. The panel's own confirms and notes all name
 * things this way.
 */
export function listNames(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.join(quoted.length > 2 ? ", " : " and ");
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line py-3.5 last:border-b-0">
      <h4 className="mb-2.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">{title}</h4>
      {children}
    </section>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 mt-2 block text-caption1 text-fg-muted first:mt-0">
      {children}
    </label>
  );
}

/** One setting: its name and what it does, and the control beside them.
 *  `htmlFor` makes the name the label of a control carrying that id; a control
 *  with no id (a Switch, the NumberInput) names itself with aria-label. */
export function SettingRow({ label, help, htmlFor, children }: { label: string; help: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-footnote font-medium text-fg">{label}</label>
        ) : (
          <div className="text-footnote font-medium text-fg">{label}</div>
        )}
        <div className="mt-px text-caption1 text-fg-subtle">{help}</div>
      </div>
      {children}
    </div>
  );
}

/** A setting that is a switch. */
export function SwitchRow({ label, help, checked, onChange, disabled }: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} help={help}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className="mt-0.5" />
    </SettingRow>
  );
}

/** A name field, as the panel's bodies draw it. `onCommit`, when given, runs as
 *  the field is left, and Enter leaves it. */
export function NameInput({ id, label = "Name", value, onChange, onCommit, placeholder }: {
  id: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  placeholder?: string;
}) {
  return (
    <>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={onCommit ? (e) => { if (e.key === "Enter") e.currentTarget.blur(); } : undefined}
        className="h-8 w-full"
      />
    </>
  );
}

/** The friendly-link field, as both modes draw it: the base address over the
 *  field. When it is saved is the caller's; `children` sits beside the field. */
export function SlugInput({ id, baseUrl, value, onChange, children }: {
  id: string;
  baseUrl: string;
  value: string;
  onChange: (v: string) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <FieldLabel htmlFor={id}>Friendly link, optional</FieldLabel>
      <span className="mb-1 block truncate font-mono text-caption2 text-fg-faint">{baseUrl}/</span>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder="lobby-tv"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 font-mono text-caption1"
        />
        {children}
      </div>
    </>
  );
}

/** A choice drawn as a card: a title, one line under it, and which is chosen.
 *  `badge` is a small word after the title ("Usual"). */
export function ChoiceCard({ title, hint, badge, pressed, disabled, onChoose }: {
  title: string;
  hint: string;
  badge?: string;
  pressed: boolean;
  disabled?: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        "flex flex-col items-start justify-start rounded-[10px] border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        pressed ? "border-accent bg-accent/12" : "border-line-strong bg-fill hover:bg-fill-hover",
        disabled && "cursor-not-allowed opacity-45 hover:bg-fill",
      )}
    >
      <span className="block text-footnote font-semibold text-fg">
        {title}
        {badge && <span className="ml-1.5 text-caption2 font-semibold uppercase tracking-wider text-accent">{badge}</span>}
      </span>
      <span className="mt-0.5 block text-caption1 text-fg-muted">{hint}</span>
    </button>
  );
}

/** A small rounded label: "panel", "Control surface", "wall". */
export function Pill({ tone, children }: { tone: "accent" | "muted"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption2 font-medium",
        tone === "accent" ? "border-accent bg-accent/12 text-accent" : "border-line-strong text-fg-muted",
      )}
    >
      {children}
    </span>
  );
}

/** The one line that says which a screen is: a pill, then what it means. `line`
 *  replaces the sentence where the screen does not exist yet. A view of no kind
 *  (nothing chosen) says only what it says when there is nothing to show. */
export function RoleLine({ surface, line, empty = "Shows nothing yet." }: { surface: ViewSurface | null; line?: string; empty?: string }) {
  if (!surface) return <div className="mt-2.5 text-footnote text-fg-muted">{empty}</div>;
  const what = SURFACE_COPY[surface];
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-footnote text-fg-muted">
      <Pill tone={surface === "console" ? "accent" : "muted"}>{what.title}</Pill>
      {line ?? what.hint}
    </div>
  );
}

/** "List in the sidebar", for a control surface. Writes the VIEW the screen
 *  shows: the sidebar lists consoles, and a console is a view. `help` replaces
 *  the line under it where the screen is not the place being talked about. */
export function SidebarRow({ checked, onChange, disabled, help }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; help?: string }) {
  return (
    <SwitchRow
      label="List in the sidebar"
      help={
        help ??
        (disabled
          ? "Choose what this screen shows first. The listing belongs to that view."
          : checked
            ? "Its console is under Consoles in the app."
            : "Kept out of the sidebar. Its buttons still work here; open it from this screen's card.")
      }
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** The view picker: views in labelled groups, then the two ways to make a new
 *  one. `newItems` false leaves those out (a picker for a view that must already
 *  exist). `noneLabel` is the row that clears the choice; `placeholder` is the
 *  unselectable first row of a picker that has not been answered yet. */
export function ViewPicker({
  groups,
  value,
  onChange,
  noneLabel,
  placeholder,
  newItems = true,
  ariaLabel = "View",
  id,
}: {
  groups: readonly { label: string; views: readonly View[] }[];
  value: string;
  onChange: (v: string) => void;
  /** The row that clears the choice; absent for a picker that cannot be cleared. */
  noneLabel?: string;
  placeholder?: string;
  newItems?: boolean;
  ariaLabel?: string;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {groups.map((g) =>
          g.views.length > 0 ? (
            <SelectGroup key={g.label}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.views.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null,
        )}
        {newItems && <SelectItem value={NEW_WALL}>+ New wall view…</SelectItem>}
        {newItems && <SelectItem value={NEW_CONTROL}>+ New control surface…</SelectItem>}
      </SelectContent>
    </Select>
  );
}

/** The strip under a panel body: what to expect, and the buttons that act. */
export function PanelFooter({ hint, children }: { hint: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-[18px] py-3">
      <span className="min-w-[150px] flex-1 text-caption1 text-fg-subtle">{hint}</span>
      {children}
    </div>
  );
}

/** The footer's way out of a thing: outlined red, so it reads as the one that
 *  destroys. */
export function DangerButton({ children, ...props }: Omit<ButtonProps, "variant" | "size">) {
  return (
    <Button
      type="button"
      variant="transparent"
      size="medium"
      className="border border-danger-9/35 font-medium text-danger-11 hover:bg-danger-9/10"
      {...props}
    >
      {children}
    </Button>
  );
}
