// views.ts — Views, outputs and the visual layout schema.
//
// What a screen shows. A View is content; an Output is a physical screen that
// renders one. The layout schema under them is the free-form editor's document
// model — by far the largest thing in here, which is why it moved first.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


import type { CalendarSelection } from "./calendar.js";

export type ViewKind =
  | "slots"
  | "dashboard"
  | "stage"
  | "transcription"
  | "custom"
  | "script"
  | "spl-rundown"
  | "calendar";

/** Empty only when `T` names every ViewKind; otherwise `never`, which nothing
 *  can be assigned to. */
type Exhaustive<T extends readonly ViewKind[]> = Exclude<ViewKind, T[number]> extends never ? T : never;

/**
 * Identity over a list of kinds, but it will not compile unless the list names
 * EVERY ViewKind.
 *
 * A `ViewKind[]` annotation refuses a kind that does not exist and says nothing
 * about one left out — and one left out is the failure that has actually
 * happened here: the new-view dialog's order list was retyped from memory, lost
 * "stage" and "spl-rundown", and two kinds became uncreatable with nothing
 * failing to say so. Wrap the list in this and the build names the kind that was
 * forgotten.
 *
 * Adding a kind to {@link ViewKind} should break every call site. That is the
 * point: each one is a place a kind has to be handled.
 */
export function everyViewKind<const T extends readonly ViewKind[]>(kinds: T & Exhaustive<T>): T {
  return kinds;
}

/**
 * Whether a display ROUTED to a view of this kind draws the kiosk top bar.
 *
 * The bar carries the brand, the plan context and the QR link home — it is the
 * operator's way off a wall screen. The full-bleed kinds suppress it so their
 * content owns the whole panel; only `slots` and `custom` keep it.
 *
 * This is deliberately a `Record` over every kind rather than a list of the
 * true ones: a list says nothing about a kind left out, and a new ViewKind that
 * silently defaults to `false` is a display that quietly loses its way home.
 * As a Record the build refuses a kind that has not decided.
 *
 * The PLACEHOLDER screens are not in here and must not be: loading, unrouted,
 * empty, not-configured and view-missing draw a bar whatever kind the routing
 * points at, because there is no content yet to bleed. `hideTopBar` overrides
 * all of it — this map is only about the default.
 *
 * Two readers, one fact: `stage-view.tsx` decides structurally which arms
 * render `ScreenTopBar`, and `outputs-section.tsx` decides whether the "Hide
 * top bar" and "Lock display" menu items would do anything on this screen.
 * `stage-view-paths.test.tsx` renders every kind and asserts the real DOM
 * against this map, so the two cannot drift apart.
 */
export const KIND_DRAWS_TOP_BAR: Record<ViewKind, boolean> = {
  slots: true,
  custom: true,
  dashboard: true,
  stage: false,
  transcription: false,
  script: false,
  "spl-rundown": false,
  calendar: false,
};

/** A live transcript line from ProdCom (pushed on "prodcom:transcript"). */
export interface TranscriptLineDTO {
  /** Stable id for keying/dedupe (falls back to a synthesized one). */
  id: string;
  /** Channel id/index from ProdCom, if provided. */
  channel: string | null;
  /** Human channel label, if provided. */
  channelName: string | null;
  /** Per-channel color from ProdCom, if it provides one (e.g. "#rrggbb"). When
   *  null the UI falls back to a deterministic per-channel color. */
  color: string | null;
  text: string;
  /** False = interim/partial hypothesis still being revised; true = finalized. */
  isFinal: boolean;
  /** ISO timestamp the line was received. */
  at: string;
}

/** A ProPresenter slide group/section (e.g. Verse, Chorus) with its color. */
export interface ProSection {
  name: string;
  /** "#rrggbb" derived from ProPresenter's rgba group color. */
  colorHex: string;
}

/** A ProPresenter named timer (countdown/clock) currently running. */
export interface ProTimer {
  name: string;
  /** Display string from the API, e.g. "00:03:00". */
  time: string;
  state: string;
}

/**
 * @deprecated The display model has been split into {@link View} (content) and
 * {@link Output} (a physical screen). DisplayInfo is retained only as a computed
 * compatibility shim in {@link StageState} so older clients (the native Apple app,
 * the legacy phone control page) keep working. Each shim entry is one Output joined
 * with the kind/ndiSource of the View it's routed to.
 */
export interface DisplayInfo {
  id: string;
  name: string;
  /** Defaults to "slots" when absent (back-compat with older settings). */
  kind?: ViewKind;
  /** NDI source name (mirrors the routed View's ndiSource). */
  ndiSource?: string | null;
}

/**
 * A named, reusable content definition — what to show, decoupled from any screen.
 * Many Views can exist; an {@link Output} is routed to exactly one View, and one
 * View can drive many Outputs.
 *
 * For slots-kind Views the actual slot configuration lives in the slots store
 * (slots.json), keyed by this View's `id` + the active service type — exactly the
 * storage the legacy per-display model used, so migrated Views reuse it untouched.
 * Resolved slots are surfaced on `StageState.slotsByView[id]`.
 */
export interface View {
  id: string;
  name: string;
  kind: ViewKind;
  /**
   * NDI source name this View should show as a video layer, or null for none.
   * Stored as the source *name* only — video never flows through the server. The
   * native Apple client discovers the source on the LAN (mDNS) and receives it
   * peer-to-peer; web clients can't render NDI and ignore this.
   */
  ndiSource?: string | null;
  /** ISO creation timestamp (for stable ordering). */
  createdAt: string;
  /** What this View is for. Absent = "display" — read through {@link viewSurface},
   *  never directly, so the default stays in one place. */
  surface?: ViewSurface;
  /** Free-form layout for kind === "custom"; null/absent for the built-in kinds. */
  layout?: LayoutDTO | null;
  /**
   * Physical-alignment config for a slots-View (so on-screen columns line up with
   * the chargers below the monitor). Absent/null → columns share width equally
   * (default). When set, columns are sized in inches against `displayWidthIn`
   * (the monitor's active width), so widths render at true physical inches.
   */
  slotsLayout?: SlotsLayout | null;
  /**
   * Hide the operator app's chrome — BOTH bands — while this View is open as a
   * console at /consoles/<id>. Absent/false = the normal shell.
   *
   * On a phone that is the 45px top bar and the 44px context bar, 89px of an
   * 844px screen returned to the console. On a desktop it is the context bar,
   * which is also where the page's name lives; the rail stays, because the rail
   * is not a band and is the way back. Honoured at every width, deliberately:
   * a setting that does nothing on the device you set it on is worse than one
   * that is occasionally unnecessary.
   *
   * NOT the same mechanism as {@link Output.hideTopBar}, and it must not be
   * merged with it. That one is per OUTPUT — a physical screen — and hides the
   * KIOSK top bar in a different document. A console has no Output row at all.
   * Same idea, second surface.
   *
   * ONE flag, not two. An operator who wants some live context back on a phone
   * already has a better tool: the phone's own context-bar item set, which can
   * be trimmed to two items without hiding the bar.
   *
   * DORMANT on a display View, the way `slotsLayout` is dormant on a non-slots
   * one: a display is served by a different document with no shell in it, so
   * there is no chrome for this to hide. It is stored rather than refused so
   * flipping a console to a display and back does not lose the setting.
   */
  hideChrome?: boolean;
  /**
   * @deprecated No longer read or written — the PCO Live Prev/Next controls were
   * removed from the script display. Kept only so an existing `views.json` still
   * parses; nothing sets it, and nothing renders from it. Drop it once no
   * supported install can still be carrying one.
   */
  showLiveControls?: boolean;
  /**
   * Which saved ScriptView column preset a "script" View renders; null/absent =
   * all columns. The same presets the /scriptview pages use, so a department's
   * column set is defined once and a display and a browser tab cannot disagree
   * about it.
   */
  scriptViewLayoutId?: string | null;
  /**
   * Which of the org's calendars a "calendar" View draws. ABSENT OR EMPTY MEANS
   * EVERY CALENDAR.
   *
   * On the VIEW rather than in settings, so two calendar views on two screens
   * can show two departments. That is the whole point of the filter: the busiest
   * observed day held thirteen events unfiltered and three under one department's
   * tag.
   *
   * Empty meaning "everything" is the OPPOSITE of the checklist's rule, where
   * nothing chosen means the feature is off. The difference is deliberate: a
   * checklist that fills itself with every note on the plan is noise, while a
   * calendar view showing nothing is simply broken, and a View is created before
   * anyone has opened its settings.
   */
  calendarSources?: CalendarSelection[] | null;
  /** Which tags a "calendar" View draws. Absent or empty means every tag, for
   *  the reason above. PCO composes several tags as OR within a tag group and
   *  AND across groups, which is why the picker groups them. */
  calendarTags?: CalendarSelection[] | null;
  /**
   * Bumped on every layout save. An editor sends back the revision it opened, so
   * a save built on a layout someone else has since replaced can be detected
   * instead of silently overwriting their work. Absent on views saved before
   * this existed, which are treated as "no revision known" and never conflict.
   */
  layoutRev?: number;
}

/** Physical layout config for a slots-View. All measurements in inches. */
export interface SlotsLayout {
  /** The monitor's active-area width (e.g. ~32.25 for a 37″ 16:9 panel). */
  displayWidthIn: number;
  /** Default width of one charger column (e.g. 3.49 for a Shure SBC220). */
  columnWidthIn: number;
}

// ── Visual layout schema (kind === "custom") ─────────────────────────────────
// A custom View is a fixed DESIGN canvas with absolutely-positioned objects.
// All positions/sizes are FRACTIONS of the canvas (0..1) so the same layout
// renders identically at any rendered size. Font/radius/padding sizes are
// fractions of canvas HEIGHT. Bound objects read the same live data the built-in
// kinds use (no new live data is introduced).

export interface LayoutCanvas {
  /** Design-space dimensions; define aspect ratio + the basis for font scaling. */
  width: number;
  height: number;
  /** Solid background behind all objects (under NDI). "#rrggbb[aa]" or null. */
  background?: string | null;
  /**
   * How the layout fits its display/editor area:
   * - "contain" (default): letterbox the design aspect (bars on mismatched screens).
   * - "fill": fill the whole window — objects (fractional) reflow to the window's
   *   shape, fonts scale by window height; no bars, no distortion.
   */
  fit?: "contain" | "fill" | "responsive";
}

export type LayoutHAlign = "left" | "center" | "right";
export type LayoutVAlign = "top" | "middle" | "bottom";

/** Generic visual styling. Every field optional; the renderer applies defaults. */
export interface LayoutStyle {
  /** Fraction of canvas HEIGHT (e.g. 0.06 ≈ 64px on a 1080-tall canvas). */
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number; // em
  color?: string;
  textAlign?: LayoutHAlign;
  vAlign?: LayoutVAlign;
  background?: string | null;
  cornerRadius?: number; // fraction of canvas height
  borderColor?: string | null;
  borderWidth?: number; // fraction of canvas height
  /**
   * The material this object is wearing: Glass, Solid, Outline or none.
   *
   * STORED, not inferred. It used to be worked out by comparing every style
   * field against a table of presets, which meant tinting a Glass object — or
   * nudging its radius — stopped it matching anything and the dropdown read
   * "Custom" for a look the operator had picked from that same dropdown two
   * clicks earlier. A surface is a choice; choices are recorded.
   *
   * Absent on everything made before this, so `surfaceOf` classifies those from
   * what they draw. It never answers "custom": every style is one of the four.
   */
  surface?: LayoutSurface;
}

/** The four materials offered in the inspector's Look section. */
export type LayoutSurface = "flat" | "glass" | "solid" | "outline";

/** Per-type configuration. The discriminant is `type`. */
export type LayoutObjectConfig =
  | { type: "text"; text: string }
  | { type: "clock"; showSeconds?: boolean; format?: "12h" | "24h"; showMeridiem?: boolean }
  // PCO Live countdown. `hideWhenIdle` renders nothing (instead of "—") when no
  // timer is live; `warnSeconds` turns the readout amber once the remaining time
  // drops to/below that many seconds (it still goes red on overtime).
  | {
      type: "countdown-timer";
      hideWhenIdle?: boolean;
      warnSeconds?: number;
      /**
       * A caption above the value — "SERVICE STARTS IN" over a countdown.
       *
       * A bare 0:04:12 on a wall does not say what it is counting to, and the
       * operator who built the layout is not the one reading it at 9am on Sunday.
       * Set on new objects by the registry; ABSENT on objects that already exist, so
       * no layout anybody built gains a caption it did not ask for. Empty or null
       * means no caption.
       */
      caption?: string | null;
    }
  // Service pacing — how far ahead/behind the plan we are right now. `scope: "item"`
  // compares the current live item's elapsed time to its planned length (from
  // pco:live); `scope: "service"` sums actual-vs-planned across the recorded service
  // timeline for a running whole-service total. Over plan reads red, under reads green.
  | {
      type: "service-pacing";
      scope?: "item" | "service";
      hideWhenIdle?: boolean;
      showLabel?: boolean;
      aheadColor?: string | null;
      behindColor?: string | null;
      caption?: string | null;
      /**
       * Lead with the wall-clock time the service is PROJECTED TO END instead of
       * the drift figure.
       *
       * The same question the drift answers, asked the way an operator asks it:
       * "when do we get out of here". The drift moves to the sub-line under
       * `showLabel`, so the two settings stay orthogonal —
       *
       * As value over sub-line, for each combination of the two:
       *
       *   off / off   3:20                    (what every existing object does)
       *   off / on    3:20    over "behind"
       *   on  / off   11:32
       *   on  / on    11:32   over "3:20 behind"
       *
       * ABSENT means off, so nothing anybody has already placed changes. See
       * projectedServiceEndMs for what the time is and when there isn't one.
       */
      showProjectedEnd?: boolean;
    }
  // ProPresenter-fed objects. `propresenterInstanceId` picks which configured
  // instance to read (omitted / "default" = the primary) — lets separate custom
  // views per auditorium point at different ProPresenter machines.
  | { type: "current-slide-text"; propresenterInstanceId?: string | null }
  | { type: "next-slide-text"; propresenterInstanceId?: string | null }
  | { type: "current-service-item"; propresenterInstanceId?: string | null }
  | { type: "next-service-item"; propresenterInstanceId?: string | null }
  | { type: "current-slide-notes"; propresenterInstanceId?: string | null }
  | { type: "slide-thumbnail"; propresenterInstanceId?: string | null }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement"; propresenterInstanceId?: string | null }
  // Home's own cards, so Home is built from the same widget set as every other
  // surface rather than being a bespoke page. Neither takes options: what they
  // show is the state of this install, and there is nothing to choose.
  | { type: "home-readiness" }
  | { type: "home-next-service" }
  | { type: "home-live-status" }
  // The stats that used to live INSIDE the live card. Split out so each can be
  // placed, sized and ordered on its own — the card's look is kept exactly, it
  // is only the container that goes. Each is integration-agnostic: the recording
  // one answers "are we getting this?" across every recorder at once.
  /**
   * Recording, as three widgets rather than one with a picker.
   *
   * `home-recording` answers it across every recorder at once — "are we getting
   * this?", which is the mid-service question. The other two watch one each, so
   * they are found by NAME in the palette instead of behind a control somebody
   * has to know to look for. A new recording integration adds one entry to
   * `recorders()` (which the combined one picks up for free) and one type here.
   */
  // `recorder` is lowercase "any" | "obs" | "reaper", the vocabulary the wall
  // `record-status` uses for the same choice. NOT called `source`: that key is
  // already carried by unrelated objects meaning unrelated things (a graph's
  // live-or-recorded, an embed's view-or-inline), and the exhaustive PICKS record
  // would then have to name all of them.
  | { type: "home-recording"; recorder?: string; showElapsed?: boolean }
  | { type: "home-recording-obs" }
  | { type: "home-recording-reaper" }
  /**
   * Streaming, the twin of the recording trio above. "home-streaming" answers
   * every platform at once through `streamers()`; the per-platform ones exist
   * for the same reason the per-recorder ones do — a combined widget reading
   * LIVE while one destination sits off air is reassurance nobody asked for.
   */
  // `platform` uses the SAME vocabulary as the wall `stream-status` — lowercase
  // "any" | "resi" | "youtube" — because it is the same key on the same union and
  // one key must not mean two things. The capitalised streamer NAME the card
  // filters and labels by comes from STREAMER_FOR, in one place.
  //
  // Absent means every platform at once, which is what this card did before the
  // setting existed.
  | {
      type: "home-streaming";
      platform?: string;
      hideWhenIdle?: boolean;
      fillWhenLive?: boolean;
      showElapsed?: boolean;
    }
  | { type: "home-streaming-resi"; hideWhenIdle?: boolean; fillWhenLive?: boolean; showElapsed?: boolean }
  | { type: "home-streaming-youtube"; hideWhenIdle?: boolean; fillWhenLive?: boolean; showElapsed?: boolean }
  // `meterId` names one Smaart meter, keyed "device::channel" as the SPL DTO
  // keys them. ABSENT — and the sentinel "loudest" — mean whichever meter is
  // loudest right now, which is what this card did before the setting existed
  // and is still what an operator who never opens the menu gets.
  //
  // Deliberately NOT the same meaning `spl-meter` gives the same key: there,
  // null falls back to the FIRST meter. Two cards, two defaults, because the
  // wall object is one chosen instrument and this one answers "how loud is it
  // in here" without being told where.
  | { type: "home-spl"; meterId?: string | null }
  | { type: "home-screens" }
  // `showSpl` draws the service-level SPL line under the attendance curve;
  // `splMetric` names which Smaart metric it plots (null = the preferred
  // default). Off by default — an existing card must not gain a second line
  // unasked.
  | { type: "home-recent-services"; showSpl?: boolean; splMetric?: string | null }
  // A timer running INSIDE ProPresenter (its stage/countdown timers) — distinct from
  // the PCO countdown. `timerName` picks one by name (blank = the first reported);
  // `warnStates` colors the readout when the timer's state reads as overrun/expired.
  | {
      type: "pp-timer";
      timerName?: string | null;
      propresenterInstanceId?: string | null;
      warnStates?: boolean;
      hideWhenIdle?: boolean;
      showLabel?: boolean;
      caption?: string | null;
    }
  // ProPresenter slide position within the current presentation. `display`: "fraction"
  // ("3 / 12"), "remaining" ("9 left"), "percent", or a progress "bar".
  | { type: "slide-progress"; propresenterInstanceId?: string | null; display?: "fraction" | "remaining" | "percent" | "bar"; showLabel?: boolean }
  // Mic-slots grid. `source: "view"` embeds an existing slots-View's grid by
  // `sourceViewId`; `source: "inline"` defines its own slot set, stored per service
  // type keyed by this object's id (resolved into `StageState.slotsByLayoutObject`),
  // with `slotsLayout` holding its physical-inch alignment. Missing `source` ==
  // "view" (back-compat with existing objects).
  | { type: "slots-grid"; source?: "view" | "inline"; sourceViewId?: string | null; slotsLayout?: SlotsLayout | null }
  // `hideChannels` drops lines from the named ProdCom channels (by channel name)
  // so a strip can show only the channels you care about.
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number; hideChannels?: string[] }
  | { type: "live-controls" } // PCO Services Live Prev/Next buttons (interactive)
  // The operator's own work product, stored per object id in notes.json (a
  // "config" store, so it rides along in every backup). `placeholder` is the
  // prompt shown while empty; the content itself is never in the layout.
  | { type: "notes"; placeholder?: string }
  // No `resetDaily`: it was declared here and read by nothing, for its whole
  // life. The rows come from the plan's notes now, and their ticks are stored
  // per plan — so the reset happens because a new plan is a new set of keys,
  // not because a flag asked for it.
  | { type: "checklist"; title?: string }
  // A button bound to an entry in the automation action registry. The general
  // form of osc-button/rosstalk-button, which stay as they are so existing
  // layouts keep working — this is for everything else the registry can already
  // do, including advancing PCO Live.
  | { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string }
  // Shure SBC charger bay battery levels. `bays` lists which bays to show (by
  // ChargerBay id) with an optional custom label; `show` toggles each metric.
  | {
      type: "charger-battery";
      bays: { id: string; label?: string }[];
      show: { battery?: boolean; charging?: boolean; cycles?: boolean; health?: boolean; temp?: boolean };
    }
  | { type: "brand-logo"; useEmptySlotLogo?: boolean }
  | { type: "ndi-video" } // background; web shows a placeholder, Apple shows video
  | { type: "image"; src: string }
  // A file attached to the CURRENT PCO plan, matched by filename each week so the
  // object auto-tracks the live plan (e.g. the Sunday stage plot). PDFs render
  // client-side; images render directly. `match` is a case-insensitive filename
  // substring (default "stage plot"); `page` is the 1-based PDF page. The rendered
  // image (not the source file) is post-processed: optional manual `crop` (edge
  // insets 0..1), `trim` of surrounding whitespace, and `background` recolor of the
  // near-white page (keep / fill black / knock out to transparent).
  | {
      type: "plan-attachment";
      match?: string;
      page?: number;
      crop?: { top: number; right: number; bottom: number; left: number };
      trim?: boolean;
      background?: "keep" | "black" | "transparent";
    }
  // A live SPL value from Smaart. `meterId` selects a device/channel
  // ("device::channel"); `metricKey` selects which value to show (e.g. "SPL A
  // Slow", "LAeq 10"); both default to the first available. Optional thresholds
  // color the readout amber/red above the given dB levels.
  | {
      type: "spl-meter";
      caption?: string | null;
      meterId?: string | null;
      metricKey?: string | null;
      showLabel?: boolean;
      thresholds?: { amber: number; red: number } | null;
      /** Hold the highest value seen (resets on reload / meter change) instead of the live reading. */
      peakHold?: boolean;
    }
  // Live OBS output indicator (from the OBS integration, `StageState`-adjacent
  // `obs:status` channel). `mode` picks which output to reflect — recording
  // (default, back-compat), streaming, or virtual camera. Turns red while that
  // output is active. The label texts override the per-mode defaults
  // ("Recording" / "Standby" / "Offline" for recording, etc. — bare, because the
  // caption already says OBS; see STATUS_TEXT in layout-renderer).
  // `hideWhenIdle` makes it a pure tally light (render nothing unless active);
  // `fillWhenRecording` fills the whole box red instead of just coloring the
  // text; `showTimecode` appends the record duration (recording mode only).
  | {
      type: "obs-status";
      mode?: "recording" | "streaming" | "virtualcam";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      showTimecode?: boolean;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  // "Is anything recording?" — one indicator across every recorder, so a layout does
  // not need to know whether the campus records on OBS or REAPER. `source: "any"`
  // is red when EITHER is recording. The device-specific obs-status/reaper-status
  // objects remain for when you want exactly one machine.
  | {
      type: "record-status";
      source?: "any" | "obs" | "reaper";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  /** Live streaming indicator. `platform` "any" answers every platform at once
   *  through streamers(); a named one reports just that platform. */
  | {
      type: "stream-status";
      platform?: "any" | "resi" | "youtube";
      showElapsed?: boolean;
      hideWhenIdle?: boolean;
      /** Paint the whole widget green while live, rather than colouring the
       *  word. Off by default: red is what a recorder means by rolling, and a
       *  wall carrying both wants one of them shouting, not two. */
      fillWhenLive?: boolean;
    }
  // Live REAPER recording indicator (from the REAPER integration, `reaper:status`
  // channel). Turns red while REAPER is recording. Label texts override the
  // defaults ("Recording" / "Standby" / "Offline" — bare, because the caption
  // already says REAPER; see STATUS_TEXT in layout-renderer);
  // `hideWhenIdle` makes it a pure tally light (render nothing unless recording);
  // `fillWhenRecording` fills the whole box red instead of just coloring the text;
  // `showPosition` appends REAPER's transport position while recording.
  | {
      type: "reaper-status";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      showPosition?: boolean;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  // ProVideoPlayer layer state (from the PVP integration, `pvp:status` channel).
  //
  // A LIST, not a status slab: PVP is up to eleven layers and the useful question
  // is which of them are showing something. `show` filters, because eleven rows
  // do not fit a wall tile at wall-legible type and two of eleven was the
  // observed steady state.
  //
  // There is no picture option because PVP has no preview, thumbnail or frame
  // endpoint of any kind. Every reading here is a name, a state or a time.
  //
  // The keys are `hideWhenEmpty` and `showProgress` rather than the recorders'
  // `hideWhenIdle` / `showPosition` deliberately: card-toggles.ts declares an
  // exhaustive record over every type carrying those keys, and reusing one to
  // inherit a free Home toggle would put two different meanings behind one word.
  // PVP's "nothing on this layer" is not a recorder's "nothing is going out".
  //
  // ONE ROW PER LAYER, in the shape charger-battery uses: the label truncates
  // and flexes left, the values sit right in tabular figures, and an absent row
  // is the word `empty` at low opacity. The two-line row this drew before was
  // neither of the two conventions the app already had.
  //
  // "Last cue" is NOT here any more. `playingItem` is residual — four idle
  // layers were observed naming the same cue while showing nothing, and it
  // disagrees on live layers too — so it cannot be the loudest text on a tile.
  // It survives on the DTO, where actions verify against it, and on `pvp-now`
  // as the anchor for the next-cue lookup.
  | {
      type: "pvp-layers";
      /** "with-content" is the default: it turns an eleven-row list into a
       *  two-row one and is the question an operator glancing at a wall is
       *  actually asking. "one" needs `layerName`. */
      show?: "with-content" | "all" | "one";
      /** For `show: "one"`. Matched on the layer's NAME, not its uuid: a uuid is
       *  opaque in an inspector, and a workspace rebuilt from a template has new
       *  uuids for the same layers. */
      layerName?: string | null;
      /**
       * Draw the hairline progress rule under a rolling clip.
       *
       * The TIME is not behind this and never was — it is the reading the widget
       * exists for. This is the bar alone, and it defaults OFF on a list: four
       * hairlines stacked in a wall tile is a texture rather than four readings.
       */
      showProgress?: boolean;
      /** Render nothing at all when no layer matches — a tally light rather than
       *  an empty box. */
      hideWhenEmpty?: boolean;
    }
  // ProVideoPlayer, on the operator's own page: what is on screen and how long
  // is left. Always "layers with content" — a Home tile has room for the answer,
  // not for eleven rows of mostly nothing.
  //
  // It CARRIES A CAPTION now, which is the operator's actual complaint about it:
  // three rows of bare text could belong to any integration in the building,
  // while every card beside it says ProPresenter or Recording or People.
  | {
      type: "home-pvp";
      /** The hairline rule under a rolling clip. Same key and same meaning as
       *  the wall object's, so an operator learns it once. */
      showProgress?: boolean;
    }
  // ProVideoPlayer, as ONE reading rather than a list: what is on now, and how
  // long is left.
  //
  // The list above answers "what is every layer doing", which is a question an
  // operator asks while setting up. This answers "what is on right now", which
  // is the question during a service — so it uses the app's OTHER convention,
  // the caption / value / sub readout fifteen types already share, rather than a
  // shrunken copy of the list.
  | {
      type: "pvp-now";
      /** Which layer this reads, by NAME. Empty follows whichever layer holds
       *  content, preferring the topmost — which is what a wall wants, since
       *  nobody is there to pick. */
      layerName?: string | null;
      /** The hairline rule under the time. Defaults ON here: there is exactly
       *  one of them, and it is part of the composition that was approved. */
      showProgress?: boolean;
      /**
       * The next playlist entry, under everything.
       *
       * Switchable because it is a QUALIFIED answer: "next" is the next entry in
       * the playlist, which is what plays next only while the playlist keeps
       * auto-advancing. A hand-fired cue makes it wrong until the next poll.
       */
      showNextCue?: boolean;
    }
  // The same reading on the operator's own page. No `layerName`: Home's card
  // settings are a short menu of switches, so a text field there would be a
  // control the card can never reach — and a Home tile wants the answer, not a
  // set-up step before it says anything.
  | {
      type: "home-pvp-now";
      showProgress?: boolean;
      showNextCue?: boolean;
    }
  // Followed scores on the operator's own Home page. A quiet composition, NOT
  // the wall strip: a Home tile sits beside a readiness list and a next-service
  // card, and a panel of brand colour would out-shout every one of them. The
  // team colour survives as the chip.
  // No size/when here, unlike the plan's snippet: Home's size and visibility live
  // on LayoutObject.home (HomePlacement), which is where the editor writes them
  // and the grid reads them. Every sibling home-* member omits them for the same
  // reason, and a config field nothing ever fills is a branch never exercised.
  | {
      type: "home-scores";
      /** Which followed game this card leads with — the same field, and the same
       *  values, as the wall object above, because "which game" is one idea and
       *  an operator should not learn it twice. `"auto"` follows whichever
       *  followed game is live, preferring the one that scored most recently.
       *  Otherwise an ESPN TEAM id (`league:teamId` — see teamPin). Never an
       *  event id, which is a per-day value that means nothing next week.
       *
       *  Optional here, unlike the wall object's, because every home-scores card
       *  saved before this has no value to read and `"auto"` is what it was
       *  already doing. */
      game?: "auto" | string;
    }
  // A followed team's live score, from the ESPN scores integration
  // (`scores:status` channel). Renders ScoreStrip at wall size, scaled to fill
  // its tile.
  //
  // It is the only surface that draws the whole strip. The context-bar capsule
  // composes two ScoreSides directly, and the Home card deliberately draws
  // neither -- see ScoresCard, which explains why a tile of brand colour would
  // out-shout the quiet cards beside it. What all three DO share is score-ink,
  // so they cannot disagree about whether a team's colour takes white text.
  | {
      type: "scores";
      /** Which followed game this object shows. `"auto"` follows whichever
       *  followed game is live, preferring the one that scored most recently --
       *  which is what a wall display wants, since nobody is there to pick.
       *  Otherwise an ESPN TEAM id: the object resolves that team's game of the
       *  day. Never an event id, which is a per-day value that means nothing next
       *  week. */
      game: "auto" | string;
      /** Show the sport-specific centre, or just the score and the status. */
      detail?: boolean;
    }
  // A RossTalk control button. Tapping it (on a real display / operator surface,
  // never in the editor) fires `commandId` with `params` at `targetId`, or `raw`
  // when no catalogue command is chosen. No feedback bind: RossTalk is send-only,
  // so a button is a trigger and never an indicator.
  | {
      type: "rosstalk-button";
      targetId: string | null;
      commandId: string | null;
      params: Record<string, string | number>;
      label: string;
      raw?: string;
    }
  // An OSC control button. Tapping it (on a real display / operator surface, never
  // in the editor) sends `address` + `args` to the chosen OSC target. `feedback`
  // optionally lights the button from incoming OSC. Send-only if no feedback bind.
  | {
      type: "osc-button";
      targetId?: string | null;
      label?: string;
      address: string;
      args?: OscArg[];
      feedback?: OscFeedbackBind | null;
    }
  | { type: "shape"; shape: "rect" | "ellipse" }
  // A connection-status light for any integration, driven by the
  // "integrations:state-changed" channel. `integrationId` selects which (null =
  // first). Dot color reflects the live connection (green/amber/red/gray);
  // `label` overrides the integration's friendly name.
  | {
      type: "integration-status";
      integrationId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  // A compact wireless fleet summary computed from all configured connections'
  // channels: `showOnline` → "online/total", `showBattery` → the lowest live
  // battery % (colored), `showRuntime` → the shortest runtime remaining across
  // the fleet. Optional `label` prefix when `showLabel`.
  | {
      type: "wireless-summary";
      showOnline?: boolean;
      showBattery?: boolean;
      showRuntime?: boolean;
      label?: string;
      showLabel?: boolean;
    }
  // A focused single wireless channel readout (e.g. a "Pastor's mic" tile). `channelId`
  // is the namespaced device channel; `show` toggles which metrics appear. Reads the
  // same live wireless data as the slots/summary.
  | {
      type: "wireless-channel";
      channelId?: string | null;
      // `runtime` is the pack's time remaining, the figure Wireless Workbench
      // leads with. Independent of `battery` on purpose: a 60% pack with 40
      // minutes left and a 60% pack with three hours left are the same
      // percentage and a different decision.
      show?: { rf?: boolean; battery?: boolean; runtime?: boolean; frequency?: boolean; audio?: boolean };
      showLabel?: boolean;
    }
  // A live people count from the SenSource Vea integration ("people:count"
  // channel). `metric` picks attendance (Σins today) or occupancy (in-room now);
  // `zoneId` null = building total, else a single zone. Optional `label` shown
  // when `showLabel`.
  | {
      type: "people-counter";
      caption?: string | null;
      // attendance (Σins) / occupancy (in-room now) resolve per-zone or building;
      // peak/min/avg (today, from the space endpoint) are building-only.
      /** "peak"/"avg"/"attendance" are TODAY's building figures, so a second
       *  event on the same day inherits the morning's numbers. The "service*"
       *  metrics come from the in-progress attendance record and reset per
       *  service occurrence. */
      metric?:
        | "attendance"
        | "serviceAttendance"
        | "occupancy"
        | "peak"
        | "servicePeak"
        | "servicePeakAttendance"
        | "min"
        | "avg";
      zoneId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  // The current PCO service order as a full list. Highlights the live item and
  // shows each item's notes (e.g. vocal parts). `noteCategories`: null = all
  // present, [] = none, [..] = chosen. `scroll`: "auto" keeps the live item in
  // view; "static" renders in place. Reuses the cached plan-items pipeline.
  | {
      type: "service-order";
      noteCategories?: string[] | null;
      showLength?: boolean;
      highlightLive?: boolean;
      scroll?: "auto" | "static";
      /** Shrink the text so the whole order fits the object height (no scroll). */
      autoFit?: boolean;
    }
  // A trend sparkline of the building-total people count over the rolling
  // in-memory history (people:count `history`). `metric` picks attendance or
  // occupancy; optional `label` + current value shown when `showLabel`.
  | {
      type: "people-graph";
      metric?: "attendance" | "occupancy";
      label?: string;
      showLabel?: boolean;
      source?: "live" | "recorded";
      recordedServiceKey?: string | null;
      showMarkers?: boolean;
      showTooltip?: boolean;
      kioskToggle?: boolean;
    }
  // A multi-metric people summary — several building-wide counts side by side,
  // each toggleable. `metrics` is the ordered set shown. avgService is the mean
  // peak occupancy across recorded services (from Attendance history).
  | {
      type: "people-panel";
      metrics?: ("occupancy" | "peak" | "servicePeak" | "servicePeakAttendance" | "attendance" | "serviceAttendance" | "min" | "avg" | "avgService" | "capacity" | "vsAverage")[];
      showLabels?: boolean;
      orientation?: "row" | "column";
    }
  // A readout from the baptism timer (operator stopwatch). `field` picks what to
  // show: the live phase + running clock, or a session stat. Self-contained — no
  // integration required.
  | {
      type: "baptism-timer";
      caption?: string | null;
      field?: "live" | "count" | "total" | "average" | "last";
      label?: string;
      showLabel?: boolean;
    }
  // A styled box that holds other objects. Children are positioned as fractions
  // of THIS container's box (not the canvas), so moving/resizing the container
  // moves/scales its contents as a unit. The box itself is drawn from `style`
  // (background/border/radius/padding) — same fields as any other object.
  // Render another View's content inside this layout, natively — the same
  // components the View renders on its own display, not an iframe of it. Built
  // for the ScriptView rundown, which is a whole page's worth of table nobody
  // wants to rebuild as objects; other kinds opt in as they stop assuming they
  // own the screen. `viewId` null = nothing chosen yet.
  | {
      type: "view-embed";
      viewId?: string | null;
      /** Show the embedded view's own header bar (plan title, countdown, clock).
       *  Off by default: a layout usually has its own, and two clocks a few
       *  hundred pixels apart is worse than none. */
      showHeader?: boolean;
      /**
       * Keep the live PCO item scrolled into view. Absent = on.
       *
       * On by default because the alternative is an operator walking to the
       * screen mid-service. It is a toggle rather than always-on because an
       * embed is often deliberately parked on the top of the plan — a pre-service
       * checklist, or a box only tall enough for a couple of rows, where the view
       * jumping to the middle of the plan is the wrong answer.
       */
      autoScroll?: boolean;
    }
  | {
      /**
       * A SCREEN, not a view: shows whatever that display is currently routed
       * to, and follows it when somebody changes the routing mid-service.
       *
       * The producer primitive. A view-embed pins one view for ever, which is
       * right for a fixed reference panel and wrong for "what is on that screen
       * right now". It is also the only way dashboard, stage and SPL-rundown
       * kinds can be embedded at all, because all three are configured per
       * display.
       *
       * `outputId` null = nothing chosen yet.
       */
      type: "screen-embed";
      outputId: string | null;
      /** The screen's name across the top of the tile. Absent = on. */
      showLabel?: boolean;
      /** A dot beside that name: lit while the screen is showing its view, dark
       *  while it is unrouted or blacked out. Absent = on. */
      showStatus?: boolean;
    }
  | { type: "container" };

export type LayoutObjectType = LayoutObjectConfig["type"];

/**
 * Which tile a widget fills on Home's grid — columns × rows.
 *
 * Five preset shapes on a three-column grid, chosen so they tile: `S 1×1`,
 * `M 2×1`, `L 2×2`, `XL 3×2`, `Tall 3×4`. `S + M`, `S + L` and `S + S + S` each fill a row,
 * and a Large leaves a 1-wide, 2-tall gap that two stacked Smalls complete
 * exactly. Small is 1×1, so every leftover slot is fillable and nothing can
 * strand a gap.
 *
 * Deliberately NOT a width and a height: a size is a choice from four, which is
 * what keeps Home free of a canvas.
 */
export type HomeCardSize = "s" | "m" | "l" | "xl" | "tall";

/**
 * When a Home card is on the page.
 *
 * Home has two moods — a service is running, or it is the rest of the week — and
 * this used to be a rule hidden in the code: the timer simply belonged to "live"
 * and vanished for six days. Once an operator places widgets themselves, a card
 * that disappears without being asked to looks broken, so the rule becomes a
 * setting they can see and change.
 */
export type HomeVisibility = "always" | "live" | "idle";

/** Where a widget sits on Home. Absent on objects that live on a canvas. */
export interface HomePlacement {
  size?: HomeCardSize;
  when?: HomeVisibility;
  /**
   * Where the operator put this card, as 1-based grid cells.
   *
   * Absent means "flow" — the packed behaviour Home has always had, and what
   * every card on disk carries until somebody drags one. Present means exactly
   * here, gaps included: leaving space between two widgets is a thing you can
   * ask for, and a packing grid has no way to express it.
   *
   * Dropped below about 520px, where the grid narrows to two columns and then
   * one. A column chosen on a three-wide page is not a column on a phone, and
   * honouring it there would leave holes down a screen that has no room for
   * them.
   */
  col?: number;
  row?: number;
}

export interface LayoutObject {
  id: string;
  /**
   * Home only: the grid tile and when to show it.
   *
   * Home reads this INSTEAD of x/y/w/h — it has no canvas, so the geometry below
   * is filler the type requires. On every other surface this is absent and the
   * geometry is the real thing. See main/services/home-view.ts.
   */
  home?: HomePlacement;
  /** Position/size as fractions of the PARENT (the canvas for top-level objects,
   *  or the containing container's box for nested children) — all 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint order WITHIN the object's sibling scope; higher = front. */
  z: number;
  hidden?: boolean;
  /** When true, the editor won't move/resize/reparent/delete this object — and,
   *  for a container, anything nested inside it — until it's unlocked. */
  locked?: boolean;
  style?: LayoutStyle;
  config: LayoutObjectConfig;
  /**
   * Responsive behaviour. All optional and all OFF by default, so an object that
   * sets none of them lays out exactly as it always has — see
   * renderer/main/responsive-layout.ts.
   */
  /** Pin an edge instead of drifting proportionally. The pinned distance is held
   *  in DESIGN pixels, which is what makes it an anchor rather than a fraction. */
  anchor?: { x?: "left" | "right" | "center"; y?: "top" | "bottom" | "center" };
  /** Scale evenly inside the space given rather than stretching. For logos,
   *  thumbnails, video — anything with a natural shape. */
  keepAspect?: boolean;
  /** Floor in real pixels, so a control cannot shrink below a tappable size. */
  minPx?: { w?: number; h?: number };
  /** Ceiling in real pixels, so an object cannot balloon on a 4K wall. */
  maxPx?: { w?: number; h?: number };
  /** Nested objects, positioned relative to this object's box. Only meaningful
   *  for `container` objects; absent/empty for leaf objects. */
  children?: LayoutObject[];
}

export interface LayoutDTO {
  /** Schema version — bump when the shape changes so old layouts can migrate. */
  version: 1;
  canvas: LayoutCanvas;
  objects: LayoutObject[];
}

/** A named, reusable custom layout — saved to a library, applied to any custom View. */
export interface LayoutTemplate {
  id: string;
  name: string;
  layout: LayoutDTO;
  createdAt: string;
}

/** A named, reusable single object (typically a container + its children) that can
 *  be inserted into any custom View — a "group" in the editor. */
export interface LayoutGroup {
  id: string;
  name: string;
  object: LayoutObject;
  createdAt: string;
}

/**
 * What a View is FOR.
 *
 * A layout is designed for one context, not both: a display View is read from
 * across a room and carries no controls; a console View is laid out for arm's
 * length and can carry controls, drill-down targets and editable fields. A
 * single layout forced to serve both is worse at each.
 */
export type ViewSurface = "display" | "console";

/**
 * How an Output renders.
 *
 * `display` is a read-only wall screen. `panel` is a console pinned chrome-free
 * to a physical screen — which is how a control surface is built. An Output is a
 * display unless deliberately changed, so nothing becomes interactive by
 * accident.
 */
export type OutputMode = "display" | "panel";

/** A View's surface. Absent means "display": a View written before this field
 *  existed was rendering on a wall screen, and anything unrecognised (a hand
 *  edit, a downgrade) must read as the read-only one rather than the live one. */
export function viewSurface(v: Pick<View, "surface">): ViewSurface {
  return v.surface === "console" ? "console" : "display";
}

/** An Output's mode. Absent — or unrecognised — means "display". The safety
 *  property is an explicit opt-in, never an inference. */
export function outputMode(o: Pick<Output, "mode">): OutputMode {
  return o.mode === "panel" ? "panel" : "display";
}

/** A physical screen at a URL slug, routed to exactly one View (or none). */
export interface Output {
  /** Permanent. Never rewritten after creation — slots.json and every other store
   *  is keyed by this, and Pis/bookmarks/QR codes point at `/<id>`. */
  id: string;
  name: string;
  /** Optional friendly URL. `/<id>` always resolves; when this is set, `/<slug>`
   *  resolves to the same display. Never used as a storage key, so clearing it
   *  cannot orphan anything. Validated against RESERVED_SLUGS on save. */
  slug?: string;
  /** The View this screen currently shows, or null when unrouted (renders a placeholder). */
  viewId: string | null;
  /** When true, this screen renders a full black "blackout" regardless of its
   *  routed View. Toggling it off restores the View instantly. */
  blackout?: boolean;
  /** When true, this display's top bar hides its nav escape hatches (QR/settings +
   *  home logo) so a handed-out link can't navigate away from the display. */
  locked?: boolean;
  /** When true, this display draws no top bar at all — no brand, plan context or
   *  QR — and its content fills the strip the bar would have taken. Absent means
   *  the bar shows, which is what every screen did before this existed.
   *  Independent of `locked`, which KEEPS the bar and only strips its links. */
  hideTopBar?: boolean;
  /** How this screen renders. Absent = "display" — read through {@link outputMode}.
   *  Only a "panel" may be bound to a console View, enforced server-side in
   *  stage-controller's setOutputView. */
  mode?: OutputMode;
}

/** Per-output render descriptor so the kiosk needs no client-side joins. */
export interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
  blackout: boolean;
  locked: boolean;
  /** Resolved {@link Output.hideTopBar}. It rides here as well as on the Output
   *  because this descriptor is what the kiosk reads — leaving it off would make
   *  every display do the outputs lookup this type exists to prevent. */
  hideTopBar: boolean;
}

/**
 * Live PCO countdown (pushed on "pco:live"). Mirrors PCO's green timer, which
 * always counts DOWN: to the service start before service ("preservice"), then
 * each item's length while live ("item"). "none" = nothing to count down to.
 */

/**
 * Is this a layout the renderer can actually draw?
 *
 * This used to be `typeof layout === "object"` followed by a cast, which let any
 * object through. Two consequences, both real: `canvas.width` is read unguarded
 * in the renderer, so a layout without one crashed the display it was saved to;
 * and `objects.length` went straight into a log line, so an `objects` of
 * `{ length: "…\n[stage-controller] …" }` forged entries on the LAN-visible
 * /log page. Validating the shape closes both at the door.
 *
 * Deliberately shallow — it checks what the renderer and the log actually
 * require, not every optional field of a LayoutObject.
 *
 * Lives here rather than in a route module because more than one writer needs
 * it: the PATCH path has always checked, and an imported bundle is a file off
 * somebody's laptop.
 */
export function isLayoutShape(v: unknown): v is LayoutDTO {
  if (!v || typeof v !== "object") return false;
  const l = v as { objects?: unknown; canvas?: unknown };
  if (!Array.isArray(l.objects)) return false;
  if (!l.canvas || typeof l.canvas !== "object") return false;
  const c = l.canvas as { width?: unknown; height?: unknown };
  return (
    typeof c.width === "number" && Number.isFinite(c.width) &&
    typeof c.height === "number" && Number.isFinite(c.height)
  );
}
