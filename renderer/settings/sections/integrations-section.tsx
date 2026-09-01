import { useNavigate, useSearch } from "@tanstack/react-router";
import { IntegrationsPanel } from "../../components/integrations-panel";

/**
 * The Integrations page, with the open settings dialog held in the URL.
 *
 * `/settings/integrations?integration=obs`. Making it URL state buys three
 * things: the browser's Back button closes the dialog instead of leaving the
 * page — on a wall-mounted console Back is often the only navigation there is —
 * a link can be handed to someone, and a reload comes back to the same place.
 *
 * Here rather than inside IntegrationsPanel so the panel does not require a
 * router to render. It takes `open`/`onOpenChange` when told and holds the state
 * itself otherwise, the same shape the app's own Dialog uses.
 *
 * `strict: false` and the `as never` casts: this router deliberately does not
 * declare the `Register` module augmentation (the kiosk router claims it, and
 * the augmentation is global — see renderer/app/router.tsx), so routes are not
 * narrowed to literals and search is not typed per route. Same precedent as
 * app/screens/screens-route.tsx.
 */
export function IntegrationsSection() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { integration?: string };
  const open = typeof search.integration === "string" ? search.integration : null;

  return (
    <div className="pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <IntegrationsPanel
        open={open}
        onOpenChange={(next) => {
          void navigate({
            to: "/settings/integrations",
            // Dropped rather than set to null, so a closed dialog leaves a clean
            // URL to copy.
            search: (next ? { integration: next } : {}) as never,
            // An open dialog is a place you can go Back from; closing it again
            // must not stack a second entry to go Back through.
            replace: next === null,
          } as never);
        }}
      />
    </div>
  );
}
