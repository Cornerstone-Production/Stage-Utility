// The New screen mode of the side panel: two steps, the name and what it shows.
//
// NOTHING IS CREATED until "Create screen" on the last step, and closing the panel
// creates nothing at all. What a new screen shows is also what it is: a new wall
// view makes a wall display, a new control surface makes a control surface, and an
// existing view makes the screen whatever that view is.

import { useState, type Dispatch, type SetStateAction } from "react";

import { Button, ErrorNote } from "../../components/ui";
import { useDevices } from "../../app/screens/use-devices";
import { viewIsConsole, viewSurface, type CreateScreenInput, type NewViewKind } from "@main/types/views";
import { ChoiceCard, NameInput, PanelFooter, RoleLine, Section, SlugInput, ViewPicker, viewGroups } from "./screen-panel-parts";
import type { PanelTarget, ScreenPanelActions } from "./screen-settings-panel";

export type Step = 1 | 2;
export const STEP_TITLES = ["Name it", "What should it show?"] as const;

type Show = "newwall" | "newcontrol" | "existing" | "none";

/** The two choices that make a view with the screen: what to ask the server for, and
 *  what to call it. */
const NEW_VIEW: Partial<Record<Show, { kind: NewViewKind; noun: string }>> = {
  newwall: { kind: "wall", noun: "wall view" },
  newcontrol: { kind: "control", noun: "control surface" },
};
export function NewScreenBody({ target, outputs, views, baseUrl, step, setStep, actions }: {
  target: Extract<PanelTarget, { kind: "new" }>;
  outputs: Output[];
  /** Every view a screen could show (Home already left out). */
  views: View[];
  baseUrl: string;
  step: Step;
  setStep: Dispatch<SetStateAction<Step>>;
  actions: Pick<ScreenPanelActions, "onCreate">;
}) {
  const [name, setName] = useState(target.defaultName);
  const [slug, setSlug] = useState("");
  // A new wall view is what most screens are, so it is the default.
  const [show, setShow] = useState<Show>("newwall");
  const [existing, setExisting] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The device this is for may be bound by another operator while the form is
  // open. It is no longer waiting then, the server refuses to make it a new
  // screen, and the form says so rather than inviting a claim that fails.
  const { bound } = useDevices();
  const taken = target.device ? bound.find((d) => d.id === target.device!.id) : undefined;
  // Not while this form is creating: its own claim binds the device, and the list
  // read back after it says so before the form is gone.
  const takenBy = taken && !busy ? (outputs.find((o) => o.id === taken.outputId)?.name ?? taken.outputId) : null;

  const picked = views.find((v) => v.id === existing);
  // A screen left unnamed is named by the server from the id it issues, which the
  // page cannot know (an id is never reused), so the copy says so rather than
  // guess a number.
  const called = name.trim() ? `called "${name.trim()}"` : "named like the screen";
  const madeView = NEW_VIEW[show];

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const input: CreateScreenInput = {
        // Omitted when empty, so the server names the screen from its id.
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(madeView
          ? { newView: madeView.kind }
          // The kind the role line showed: the server refuses if the view is the
          // other kind by the time the screen is made.
          : show === "existing" && picked ? { viewId: picked.id, expectSurface: viewSurface(picked) } : {}),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
      };
      const { refused, viewChanged } = await actions.onCreate(input, target.device);
      if (refused) {
        setError(refused);
        // The friendly link is the one answer the form cannot rule out itself, and
        // it is on the first step. A view that changed kind stays here: it is what
        // the operator is looking at, and its role line now says what it is.
        if (slug.trim() && !viewChanged) setStep(1);
      }
    } finally {
      setBusy(false);
    }
  }

  const hint =
    step === 1
      ? target.device
        ? "Nothing is created until the last step. The device then shows this screen."
        : "Nothing is created until the last step."
      : madeView
        ? `Creates the screen and a ${madeView.noun}, both ${name.trim() ? called : "with the same name"}.`
        : "Creates the screen.";

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5">
        {step === 1 && (
          <Section title="Name and address">
            {/* Left empty, the server names it from the id it is given. */}
            <NameInput id="new-screen-name" value={name} onChange={setName} placeholder="Left empty: Display and its number" />
            {/* Sent with Create screen, so it has no Save of its own. */}
            <SlugInput id="new-screen-slug" baseUrl={baseUrl} value={slug} onChange={setSlug} />
            <p className="mt-1.5 text-caption1 text-fg-subtle">Its permanent address is made from its number either way.</p>
          </Section>
        )}
        {step === 2 && (
          <Section title="What it shows">
            <div role="group" aria-label="What it shows" className="grid gap-2">
              <ChoiceCard
                title={`A new ${NEW_VIEW.newwall!.noun} ${called}`}
                badge="Usual"
                hint="Read from across the room. Lay it out after."
                pressed={show === "newwall"}
                onChoose={() => setShow("newwall")}
              />
              <ChoiceCard
                title={`A new ${NEW_VIEW.newcontrol!.noun} ${called}`}
                hint="A touch screen. Its buttons work for anyone at it."
                pressed={show === "newcontrol"}
                onChoose={() => setShow("newcontrol")}
              />
              <ChoiceCard
                title="A view you already have"
                hint="A wall view or a control surface; the screen takes its kind."
                pressed={show === "existing"}
                onChoose={() => setShow("existing")}
              />
              {show === "existing" && (
                <div>
                  <ViewPicker
                    groups={viewGroups(views)}
                    value={existing}
                    onChange={setExisting}
                    placeholder="Pick a view…"
                    newItems={false}
                    ariaLabel="Existing view"
                  />
                  {picked && (
                    <RoleLine
                      surface={viewSurface(picked)}
                      line={viewIsConsole(picked) ? "Its buttons will work on this screen." : "Read-only."}
                    />
                  )}
                </div>
              )}
              <ChoiceCard
                title="Nothing yet"
                hint="Pick a view later from its card."
                pressed={show === "none"}
                onChoose={() => setShow("none")}
              />
            </div>
          </Section>
        )}
        {takenBy !== null && (
          <p role="status" className="mt-3 rounded-[9px] border border-warn-9/35 bg-warn-9/8 px-3 py-2.5 text-footnote text-fg">
            This device was set up as "{takenBy}" meanwhile, so it cannot be made a new screen. Close this to keep that,
            or release it from that screen first.
          </p>
        )}
        {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      </div>
      <PanelFooter hint={hint}>
        <span className="flex gap-2">
          {step > 1 && (
            <Button type="button" variant="filled" size="medium" className="border border-line-strong" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
          )}
          {step === 1 ? (
            <Button type="button" variant="accent" size="medium" onClick={() => setStep(2)} disabled={busy}>
              Next
            </Button>
          ) : (
            // Off while "a view you already have" has nothing picked, and for a
            // device someone else has bound meanwhile.
            <Button
              type="button"
              variant="accent"
              size="medium"
              onClick={() => void create()}
              disabled={busy || takenBy !== null || (show === "existing" && !picked)}
            >
              Create screen
            </Button>
          )}
        </span>
      </PanelFooter>
    </>
  );
}
