// The desktop page header: the active page's name, its subtitle, and whatever
// controls that page put in the actions slot.
//
// Its own file rather than a helper inside shell.tsx, because it is the surface
// that went blank on a console and it should be testable on its own. It takes
// the active page as a prop and resolves nothing: the shell resolves once and
// hands the same answer to this header and to the mobile top bar. Two
// resolutions is how they came to disagree — this matched `d.path === pathname`
// exactly while the bar matched by prefix, and neither knew about a route built
// from the operator's own Views.

import type { ActivePage } from "./active-page";
import { usePageActionsSlot } from "./page-actions";

export function PageHeader({ active }: { active: ActivePage | null }) {
  // Read here rather than passed in: Shell renders the provider, so a hook call
  // in Shell's own body would sit outside it and always see nothing.
  const actions = usePageActionsSlot();
  // Only when the URL IS this page. A child route draws its own heading — the
  // layout editor puts the view's name in an editable field, a ScriptView plan
  // draws ScriptViewHeader — so the section's name above it would be a second,
  // wronger title.
  if (!active?.exact) return null;
  const { label, description } = active.page;
  return (
    // The title and the route's own controls share ONE row. Home used to put its
    // Edit control on a second row below this one, which cost a whole band of
    // vertical space on the page that most wants it for content.
    // HIDDEN ON MOBILE. The top bar already shows the page's name, so this
    // repeated it — "Home" twice, plus a description, plus its own padding, for
    // about 85px of a 844px phone screen spent saying what the bar above it just
    // said. The actions move to that bar instead; the description is a desktop
    // luxury.
    <header className="max-sm:hidden px-5 pt-5 shrink-0 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-title2 font-semibold text-fg leading-tight">{label}</h1>
        {/* Only when there is one. A console carries no subtitle — it is
            full-bleed and wants the height — and an empty <p> still spent its
            line-height and its margin saying nothing. */}
        {description && (
          <p className="text-footnote text-fg-muted mt-1 max-w-[68ch]">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </header>
  );
}
