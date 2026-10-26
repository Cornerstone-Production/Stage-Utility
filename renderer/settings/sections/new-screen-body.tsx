// The New screen mode of the side panel: two steps, the name and what it shows.
//
// NOTHING IS CREATED until "Create screen" on the last step, and closing the panel
// creates nothing at all. What a new screen shows is also what it is: a new wall
// view makes a wall display, a new control surface makes a control surface, and an
// existing view makes the screen whatever that view is.

import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { Button, ErrorNote } from "../../components/ui";
import { useDevices } from "../../app/screens/use-devices";
import { viewIsConsole, viewSurface, type CreateScreenInput, type NewViewKind } from "@main/types/views";
import type { ViewKind } from "@main/types/stage";
import { Segmented } from "../../editor/inspector-rows";
import { startingLayout, type StartFrom, type UltritouchModel } from "../../editor/layout-templates";
import { KIND_LABELS, KIND_ORDER } from "./view-kinds";
import { ChoiceCard, NameInput, OptionGrid, OutlineButton, PanelFooter, RoleLine, Section, SlugInput, ViewPicker, viewGroups } from "./screen-panel-parts";
import type { PanelTarget, ScreenPanelActions } from "./screen-settings-panel";

export type Step = 1 | 2;
export const STEP_TITLES = ["Name it", "What should it show?"] as const;

type Show = NewViewKind | "existing" | "none";

/** What each view kind is, in one line, for the hint under the kinds. Record over
 *  every kind, so a kind added to ViewKind has to say what it is here. */
const KIND_HINTS: Record<ViewKind, string> = {
  custom: "A layout you build: any widgets, anywhere.",
  slots: "The mic slots for the plan, ready to use.",
  dashboard: "The built-in status dashboard.",
  stage: "The built-in stage display.",
  transcription: "Live captions, full screen.",
  script: "The ServiceCue rundown.",
  "spl-rundown": "Sound level against the rundown.",
  calendar: "The month calendar.",
};

/** Custom layout first, the default, then the rest in the order every picker offers. */
const WALL_ORDER: readonly ViewKind[] = ["custom", ...KIND_ORDER.filter((k) => k !== "custom")];
const WALL_KINDS = WALL_ORDER.map((k) => ({ value: k, label: KIND_LABELS[k] }));

const WALL_STARTS: readonly { value: Extract<StartFrom, "blank" | "dashboard" | "confidence">; label: string }[] = [
  { value: "blank", label: "Blank" },
  { value: "dashboard", label: "Dashboard" },
  { value: "confidence", label: "Confidence monitor" },
];

const CONTROL_STARTS: readonly { value: "blank" | UltritouchModel; label: string }[] = [
  { value: "blank", label: "Blank" },
  { value: "ultritouch-2", label: "Ultritouch-2" },
  { value: "ultritouch-2-hr", label: "Ultritouch-2-HR" },
  { value: "ultritouch-4", label: "Ultritouch-4" },
];

/** A small label over the options it names. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption1 text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

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
  const [show, setShow] = useState<Show>("wall");
  // What a new wall view shows, and what a custom one starts from. Custom and blank
  // are what the panel always made, so they are the defaults.
  const [wallKind, setWallKind] = useState<ViewKind>("custom");
  const [wallStart, setWallStart] = useState<(typeof WALL_STARTS)[number]["value"]>("blank");
  const [controlStart, setControlStart] = useState<(typeof CONTROL_STARTS)[number]["value"]>("blank");
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
  const madeView = show === "wall" || show === "control";

  /** What the screen will show, as the server is asked for it. A custom layout starting
   *  blank sends nothing beyond `newView`, so the usual request stays the one it always was. */
  function viewChoice(): Pick<CreateScreenInput, "newView" | "viewKind" | "layout" | "viewId" | "expectSurface"> {
    if (show === "control") {
      const layout = startingLayout(controlStart);
      return layout ? { newView: "control", layout } : { newView: "control" };
    }
    if (show === "wall") {
      if (wallKind !== "custom") return { newView: "wall", viewKind: wallKind };
      const layout = startingLayout(wallStart);
      return layout ? { newView: "wall", layout } : { newView: "wall" };
    }
    // The kind the role line showed: the server refuses if the view is the other
    // kind by the time the screen is made.
    if (show === "existing" && picked) return { viewId: picked.id, expectSurface: viewSurface(picked) };
    return {};
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const input: CreateScreenInput = {
        // Omitted when empty, so the server names the screen from its id.
        ...(name.trim() ? { name: name.trim() } : {}),
        ...viewChoice(),
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

  /** What the footer calls the view being made: a custom layout is "a wall view", the rest
   *  are named for what they show. */
  function madeNoun(): string {
    if (show === "control") return "control surface";
    if (wallKind === "custom") return "wall view";
    return `${KIND_LABELS[wallKind]} view`;
  }

  function footerHint(): string {
    if (step === 1) {
      return target.device
        ? "Nothing is created until the last step. The device then shows this screen."
        : "Nothing is created until the last step.";
    }
    if (!madeView) return "Creates the screen.";
    return `Creates the screen and a ${madeNoun()}, both ${name.trim() ? called : "with the same name"}.`;
  }

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
                title={`A new wall view ${called}`}
                badge="Usual"
                hint="Read from across the room."
                pressed={show === "wall"}
                onChoose={() => setShow("wall")}
              >
                <FieldGroup label="Shows">
                  <OptionGrid label="Kind of wall view" options={WALL_KINDS} value={wallKind} onChange={setWallKind} />
                </FieldGroup>
                {wallKind === "custom" && (
                  <FieldGroup label="Start from">
                    <Segmented label="Starting layout" options={WALL_STARTS} value={wallStart} onChange={setWallStart} />
                  </FieldGroup>
                )}
                <p className="text-caption1 text-fg-subtle">{KIND_HINTS[wallKind]}</p>
              </ChoiceCard>
              <ChoiceCard
                title={`A new control surface ${called}`}
                hint="A touch screen. Its buttons work for anyone at it."
                pressed={show === "control"}
                onChoose={() => setShow("control")}
              >
                <FieldGroup label="Start from">
                  <Segmented label="Starting layout" options={CONTROL_STARTS} value={controlStart} onChange={setControlStart} />
                </FieldGroup>
              </ChoiceCard>
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
      <PanelFooter hint={footerHint()}>
        <span className="flex gap-2">
          {step > 1 && (
            <OutlineButton onClick={() => setStep(1)} disabled={busy}>
              Back
            </OutlineButton>
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
