// advanced-search.ts — the matcher behind Settings > Advanced > Search.
//
// Pure: it reads a list of settings and a query and returns the ones that match,
// best first. A query is split into words and EVERY word must match somewhere in a
// setting, in any order. A word matches a whole word or the start of one, in the
// name, the card it sits in, the hidden keywords or the description. A word of four
// letters or more also tolerates a typo, in the name or the card's name only: those
// are short and exact, whereas a description is long enough that a one-letter slack
// would match nearly anything.

export interface Searchable {
  id: string;
  tab: string;
  name: string;
  /** The card's heading, so "reconnect" finds the settings under Reconnects. */
  card?: string;
  description: string;
  keywords: readonly string[];
}

/** Lower, best first. A setting's rank is its worst query word's. */
export const RANK = {
  nameWord: 0,
  namePrefix: 1,
  keyword: 2,
  description: 3,
  typo: 4,
} as const;

/** The lowercase alphanumeric words of a string. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Edits to turn `a` into `b`, where swapping two neighbours counts as one (optimal string alignment). */
export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** How many edits a query word may be off by: none under four letters, one to seven, two from eight. */
export function typoBudget(word: string): number {
  if (word.length < 4) return 0;
  return word.length >= 8 ? 2 : 1;
}

/** Is `word` within its budget of `nameWord`, or of the same-length start of a longer one? */
function isTypoOf(word: string, nameWord: string): boolean {
  const budget = typoBudget(word);
  if (budget === 0) return false;
  if (damerauLevenshtein(word, nameWord) <= budget) return true;
  // As a prefix of a longer word: "recnnect" against "reconnects" cannot match the
  // whole word within budget, but it can match "reconnec".
  if (nameWord.length > word.length) {
    for (const len of [word.length - 1, word.length, word.length + 1]) {
      if (len > 0 && len < nameWord.length && damerauLevenshtein(word, nameWord.slice(0, len)) <= budget) return true;
    }
  }
  return false;
}

interface Index {
  name: string[];
  card: string[];
  keywords: string[];
  description: string[];
}

function indexOf(s: Searchable): Index {
  return { name: wordsOf(s.name), card: wordsOf(s.card ?? ""), keywords: s.keywords.flatMap(wordsOf), description: wordsOf(s.description) };
}

/** The best (lowest) rank at which one query word matches this setting, or null when it does not. */
function rankWord(word: string, ix: Index): number | null {
  if (ix.name.includes(word)) return RANK.nameWord;
  if (ix.name.some((w) => w.startsWith(word))) return RANK.namePrefix;
  if (ix.keywords.some((w) => w.startsWith(word))) return RANK.keyword;
  if (ix.card.some((w) => w.startsWith(word))) return RANK.keyword;
  if (ix.description.some((w) => w.startsWith(word))) return RANK.description;
  if (ix.name.some((w) => isTypoOf(word, w)) || ix.card.some((w) => isTypoOf(word, w))) return RANK.typo;
  return null;
}

export interface Hit<T> {
  setting: T;
  rank: number;
}

/**
 * The settings matching `query`, grouped by `tabOrder` and ordered within a tab by
 * rank, then by their place in `settings`. An empty query matches nothing: the
 * Search tab shows a hint instead of every setting.
 */
export function searchSettings<T extends Searchable>(
  settings: readonly T[],
  query: string,
  tabOrder: readonly string[],
): Hit<T>[] {
  const queryWords = wordsOf(query);
  if (queryWords.length === 0) return [];

  const hits: { hit: Hit<T>; sum: number; at: number }[] = [];
  settings.forEach((setting, at) => {
    const ix = indexOf(setting);
    let worst = 0;
    let sum = 0;
    for (const w of queryWords) {
      const r = rankWord(w, ix);
      if (r === null) return;
      worst = Math.max(worst, r);
      sum += r;
    }
    hits.push({ hit: { setting, rank: worst }, sum, at });
  });

  const tabAt = (tab: string) => {
    const i = tabOrder.indexOf(tab);
    return i < 0 ? tabOrder.length : i;
  };
  return hits
    .sort((a, b) => tabAt(a.hit.setting.tab) - tabAt(b.hit.setting.tab) || a.hit.rank - b.hit.rank || a.sum - b.sum || a.at - b.at)
    .map((h) => h.hit);
}
