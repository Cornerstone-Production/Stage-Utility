// A ProPresenter status for the Lyrics tests: the song of the approved mockup,
// with the made-up lyrics it uses, stopped on the first slide of the first chorus.
//
// Arrangement: Intro, Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus, Outro.

import type { ProPresenterStatusDTO } from "@main/types/live";
import type { ProSection } from "@main/types/views";

const group = (name: string, colorHex: string): ProSection => ({ name, colorHex });

export const GROUPS = {
  intro: group("Intro", "#808080"),
  verse1: group("Verse 1", "#3b82f6"),
  chorus: group("Chorus", "#e5484d"),
  verse2: group("Verse 2", "#3b82f6"),
  bridge: group("Bridge", "#f59e0b"),
  outro: group("Outro", "#808080"),
} as const;

export const WORDS = {
  chorusFirst: "Sing it out, the night is over\nSing it out, the dawn is here",
  chorusSecond: "Every voice and every colour\nRising up to meet You here",
  verse2: "When the road is long and narrow\nAnd the morning seems so far",
} as const;

/** The status of the song stopped on the first slide of the first chorus. */
export function lyricsStatus(over: Partial<ProPresenterStatusDTO> = {}): ProPresenterStatusDTO {
  return {
    connected: true,
    currentItem: "Example Song",
    nextItem: WORDS.chorusSecond,
    slideIndex: 4,
    slideCount: 12,
    slidesRemaining: 8,
    currentSlideText: WORDS.chorusFirst,
    nextSlideText: WORDS.chorusSecond,
    currentNotes: null,
    nextNotes: null,
    currentSection: GROUPS.chorus,
    nextSection: GROUPS.chorus,
    nextArrangementSection: GROUPS.verse2,
    nextGroupText: WORDS.verse2,
    playOrderGroups: [GROUPS.intro, GROUPS.verse1, GROUPS.chorus, GROUPS.verse2, GROUPS.chorus, GROUPS.bridge, GROUPS.chorus, GROUPS.outro],
    playOrderGroupIndex: 2,
    currentServiceItem: null,
    nextServiceItem: null,
    timers: [],
    slidePreviewKey: null,
    ...over,
  };
}

/** Stopped on the empty Intro: no words, and Verse 1 next. */
export const atIntro = (): ProPresenterStatusDTO =>
  lyricsStatus({
    slideIndex: 1,
    currentSlideText: "",
    nextSlideText: "Morning comes and light is breaking\nEvery shadow fades away",
    currentSection: GROUPS.intro,
    nextSection: GROUPS.verse1,
    nextArrangementSection: GROUPS.verse1,
    nextGroupText: "Morning comes and light is breaking\nEvery shadow fades away",
    playOrderGroupIndex: 0,
  });

/** Stopped on the last slide: the empty Outro, nothing after it. */
export const atOutro = (): ProPresenterStatusDTO =>
  lyricsStatus({
    slideIndex: 12,
    currentSlideText: "",
    nextSlideText: null,
    currentSection: GROUPS.outro,
    nextSection: null,
    nextArrangementSection: null,
    nextGroupText: null,
    playOrderGroupIndex: 7,
  });
