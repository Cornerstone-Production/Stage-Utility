// guarded-button.tsx — a button that a service under way guards but does not disable.

import type { ReactNode } from "react";
import { LockIcon } from "lucide-react";

import { Button, type ButtonProps } from "../../components/ui";

/**
 * A control the update lock guards: Update now, Restart and Switch track on Advanced, and
 * Update the page now on the Public link card.
 *
 * The lock deliberately does NOT disable these. A live service can go wrong and
 * the operator may genuinely need to update or restart in the middle of one, so
 * each of these opens a destructive override dialog instead of refusing — that
 * is the "or override in the dialog" the lock warning promises. What was missing
 * was the affordance: while locked they rendered exactly as they do when there
 * is nothing to worry about, so the warning above them was the only thing on
 * screen saying otherwise, and "Update now" in full accent said the opposite.
 *
 * Locked, a control takes an amber lock in place of whatever icon it had and a
 * label saying that pressing it now is an override; the two that are `accent`
 * also drop to `filled`, off the encouraged primary weight. Never colour alone.
 * The tooltip repeats the reasons for a pointer user; it is never the only place
 * they are said.
 *
 * The guarded look follows being PRESSABLE, not the lock alone. A control its own
 * rules have already disabled cannot reach the override, so promising "anyway" on
 * it would be the same lie pointing the other way. That is also what keeps the
 * deferred-update banner honest: it is the one control nothing else disables, so
 * it stays guarded even mid-update, when the others have gone quiet behind their
 * own `disabled`. Tying this to `updating` instead left exactly that button
 * clickable, in full accent, on an active lock.
 */
export function GuardedButton({
  guard,
  variant,
  icon,
  label,
  lockedLabel,
  ...props
}: Omit<ButtonProps, "children" | "tooltip"> & {
  /** Why the lock is active, or null when it is not. Never feeds `disabled`. */
  guard: string[] | null;
  /** The action's own icon, shown when nothing is locked. */
  icon?: ReactNode;
  label: string;
  lockedLabel: string;
}) {
  const locked = guard !== null && !props.disabled;
  return (
    <Button
      {...props}
      variant={locked ? "filled" : variant}
      tooltip={locked ? `Locked — ${guard.join(" · ")}. You'll be asked to confirm.` : ""}
    >
      {locked ? <LockIcon className="size-3.5 text-amber-11" /> : icon}
      {locked ? lockedLabel : label}
    </Button>
  );
}
