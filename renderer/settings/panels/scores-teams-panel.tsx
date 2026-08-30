// scores-teams-panel.tsx — which teams the operator follows.
//
// Bespoke, and deliberately not built on a shared searchable-list primitive.
// This is the fifth hand-rolled search popover in the repo and the plan
// originally proposed extracting one; that was overruled, because extracting a
// primitive with a single consumer is speculative generality and migrating the
// existing four means touching slot matching and every icon field in a PR about
// sports scores.
//
// Popover, NOT select.tsx. That is not a style preference: select.tsx renders a
// native <select>, so the OS draws the open list and its own first-letter
// typeahead fights any text field placed inside it. position-picker.tsx records
// exactly this lesson in its own header and is the shape copied here.
//
// TWO STEPS INSIDE ONE POPOVER: a sport, then that sport's teams. It began as
// one flat list of every league's teams, which was fine at 124 and unusable the
// moment college arrived — college football alone is 760 clubs, and all eight
// leagues together are about 2,000. Picking the sport first is what makes the
// second list a list a person can read, and it is why the search box narrows the
// CHOSEN league rather than everything: searching 2,000 teams across eight
// leagues is the problem, not the cure.
//
// It also decides what is fetched. Nothing is requested until a league is
// chosen, and then only that league — where the flat list had to load all eight
// before it could draw a single row. That is ~2 MB of JSON to open a dropdown,
// against an undocumented endpoint whose community reference warns that
// excessive requests are blocked by IP.
//
// The WHOLE favourite is saved, not just the id — displayName, abbreviation,
// logo and colour are cached at selection time so the settings row renders
// before the first poll and no display ever reaches a.espncdn.com itself.

import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  TrashIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { LEAGUES, type LeagueId } from "@main/types/scores";
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { toast } from "../../components/ui";
import { cn } from "../../lib/cn";

function ipc<T>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(channel, payload);
}

/** The identity of a favourite. League AND id: ESPN's ids are unique per league. */
const keyOf = (f: { league: string; teamId: string }): string => `${f.league}:${f.teamId}`;

/**
 * Teams matching the query, on display name OR abbreviation.
 *
 * The abbreviation matters as much as the name: an operator who thinks of the
 * team as "NYY" should not have to know it is filed under "New York Yankees".
 * Exported so the matching rule can be tested without driving a popover.
 *
 * Applied to ONE league's teams. The caller has already chosen the sport, which
 * is what keeps "Chicago" from returning the Cubs, the White Sox, the Bears, the
 * Bulls, the Blackhawks, Chicago State and Loyola Chicago at once.
 */
export function filterTeams(teams: readonly ScoreFavourite[], query: string): ScoreFavourite[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...teams];
  return teams.filter(
    (t) => t.displayName.toLowerCase().includes(q) || t.abbreviation.toLowerCase().includes(q),
  );
}

const labelForLeague = (id: string): string => LEAGUES.find((l) => l.id === id)?.label ?? id;

/**
 * A team's logo, or its abbreviation when the CDN is blocked or the team has
 * none — 83 of college football's 760 do not.
 *
 * `.score-logo` — THE SAME DISC the strip and the capsule draw, not a copy of
 * it. ESPN's logos are PNGs in the club's own colours and a good many are navy
 * or black; the Yankees and the Packers were the pair that made the point, and
 * on the dark theme they were marks you could not see. The disc is light for
 * every team without exception, because a per-image decision would need the
 * image's own pixels and would leave the list inconsistent even if it worked.
 *
 * ONE SHAPE either way, and that is load-bearing rather than tidiness: the
 * fallback used to be bare text in a box the width of a logo, and a college
 * abbreviation is longer than a professional one — "CONC" spilled straight over
 * "Concordia-Michigan Cardinals" in the row beside it. The disc clips, so the
 * worst case is a shortened code next to the full name that is already there.
 *
 * alt is the abbreviation, so a blocked CDN degrades to readable text rather
 * than a hole in the row.
 */
function TeamMark({ team, size = 20 }: { team: { logo: string | null; abbreviation: string }; size?: number }) {
  return (
    <span
      className="score-logo"
      // The disc's own 10px is sized for the 32px strip. Scaled here so the
      // fallback code is proportionate to an 18px row rather than filling it.
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {team.logo ? (
        <img src={team.logo} alt={team.abbreviation} width={size} height={size} />
      ) : (
        team.abbreviation
      )}
    </span>
  );
}

/**
 * The add-a-team popover: a sport, then a team.
 *
 * Presentational. The league being browsed is CONTROLLED by the parent, because
 * the parent is what fetches that league's teams — a picker that owned the
 * choice would have to own the request too, and this file's whole reason for
 * splitting them is that the request is now per-league.
 *
 * Exported for its test: the query and the league must both reset when the
 * popover closes, or re-opening shows one league's list filtered by a search the
 * operator can no longer see — they see four teams, believe that is every team,
 * and cannot find the one they came for.
 */
export function TeamPicker({
  league,
  onLeague,
  teams,
  loading,
  error,
  selected,
  onToggle,
}: {
  /** The league being browsed, or null for the sport step. */
  league: LeagueId | null;
  onLeague: (league: LeagueId | null) => void;
  /** The chosen league's teams. Empty while none is chosen. */
  teams: readonly ScoreFavourite[];
  loading: boolean;
  /** Why the chosen league could not be loaded. Shown, never swallowed. */
  error: string | null;
  selected: ReadonlySet<string>;
  onToggle: (team: ScoreFavourite) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const hits = useMemo(() => filterTeams(teams, query), [teams, query]);

  /** How many of this league's teams are already followed, from what is saved
   *  rather than from the team list — the count has to be right for a league
   *  whose teams have never been fetched in this session. */
  const followedIn = useMemo(() => {
    const counts = new Map<string, number>();
    for (const key of selected) {
      const id = key.slice(0, key.indexOf(":"));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [selected]);

  function back(): void {
    onLeague(null);
    setQuery("");
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset on CLOSE, not on open: clearing on open would wipe the field
        // under an operator who reopened deliberately to refine a search. Both
        // the query and the league go, so re-opening starts at the sport step
        // rather than deep inside a league with an invisible filter on it.
        if (!next) {
          setQuery("");
          onLeague(null);
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 items-center justify-between gap-1 rounded-md border border-gray-a6 bg-gray-a2",
            "px-2.5 py-1 text-footnote text-gray-12",
            "focus:outline-none focus:border-blue-8 focus:ring-1 focus:ring-blue-8",
          )}
        >
          <span>Add a team</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-gray-9" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-80 overflow-hidden rounded-md border border-gray-a6 bg-gray-2 shadow-md",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          {league === null ? (
            // ── Step one: the sport ──────────────────────────────────────────
            <>
              <p className="border-b border-gray-a4 px-2.5 py-2 text-caption2 font-medium uppercase tracking-wider text-gray-9">
                Choose a sport
              </p>
              <div className="max-h-72 overflow-y-auto p-1">
                {LEAGUES.map((l) => {
                  const following = followedIn.get(l.id) ?? 0;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => onLeague(l.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left",
                        "text-footnote text-gray-12 hover:bg-gray-a3",
                      )}
                    >
                      <span className="truncate">{l.label}</span>
                      {following > 0 && (
                        <span className="ml-auto shrink-0 text-caption2 text-gray-9">
                          {following} followed
                        </span>
                      )}
                      <ChevronRightIcon
                        className={cn("size-3.5 shrink-0 text-gray-9", following === 0 && "ml-auto")}
                      />
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            // ── Step two: that sport's teams ─────────────────────────────────
            <>
              <div className="flex items-center gap-1 border-b border-gray-a4 p-1.5">
                <button
                  type="button"
                  onClick={back}
                  aria-label="Back to sports"
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-0.5 rounded pl-1 pr-1.5",
                    "text-caption1 text-gray-11 hover:bg-gray-a3 hover:text-gray-12",
                    "focus:outline-none focus:ring-1 focus:ring-blue-8",
                  )}
                >
                  <ChevronLeftIcon className="size-3.5" />
                  <span className="max-w-24 truncate">{labelForLeague(league)}</span>
                </button>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${labelForLeague(league).toLowerCase()}…`}
                  aria-label="Search teams"
                  className={cn(
                    "h-7 min-w-0 flex-1 rounded border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                    "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-blue-8",
                  )}
                />
              </div>

              {error && (
                <div className="border-b border-gray-a4 px-2.5 py-2">
                  <p className="flex items-start gap-1.5 text-caption1 text-amber-11">
                    <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
                    <span>
                      {labelForLeague(league)} could not be loaded — {error}
                    </span>
                  </p>
                </div>
              )}

              <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable>
                {loading && (
                  <div className="flex items-center justify-center gap-2 px-2 py-4 text-caption1 text-gray-9">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    <span>Loading teams…</span>
                  </div>
                )}
                {!loading && hits.length === 0 && (
                  <div className="px-2 py-4 text-center text-caption1 text-gray-9">
                    {teams.length === 0 ? "No teams available" : "No teams match"}
                  </div>
                )}
                {hits.map((t) => {
                  const chosen = selected.has(keyOf(t));
                  return (
                    <button
                      key={keyOf(t)}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      onClick={() => onToggle(t)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-footnote text-gray-12",
                        "hover:bg-gray-a3",
                        chosen && "bg-gray-a3",
                      )}
                    >
                      <CheckIcon
                        className={cn("size-3.5 shrink-0", chosen ? "text-accent opacity-100" : "opacity-0")}
                      />
                      <TeamMark team={t} size={18} />
                      <span className="truncate">{t.displayName}</span>
                      {chosen && <span className="ml-auto shrink-0 text-caption2 text-gray-9">Following</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function ScoresTeamsPanel({ className }: { className?: string } = {}) {
  const queryClient = useQueryClient();
  /** The league the picker is browsing, and the only one that gets fetched. */
  const [league, setLeague] = useState<LeagueId | null>(null);

  const favouritesQuery = useQuery({
    queryKey: ["scores:getFavourites"],
    queryFn: () => ipc<ScoresConfig>("scores:getFavourites"),
    retry: 1,
  });

  // ONE league, and only once the operator has asked for it. Eight league
  // requests to render a settings page nobody is editing — about 2 MB of it once
  // college is in the list — is the traffic this integration is built to avoid.
  // Cached for a day, matching the service's own team cache: a team list changes
  // about once a decade, and stepping back and forth between two sports must not
  // re-fetch either of them.
  const teamsQuery = useQuery({
    queryKey: ["scores:listTeams", league],
    queryFn: () => ipc<ScoreFavourite[]>("scores:listTeams", { league }),
    enabled: league !== null,
    staleTime: 86_400_000,
    retry: 1,
  });

  const favourites = favouritesQuery.data?.favourites ?? [];
  const selected = new Set(favourites.map(keyOf));

  async function save(next: ScoreFavourite[]): Promise<void> {
    // Optimistic, then reconciled with what the server says it stored.
    queryClient.setQueryData(["scores:getFavourites"], { favourites: next });
    try {
      const saved = await ipc<ScoresConfig>("scores:setFavourites", { favourites: next });
      queryClient.setQueryData(["scores:getFavourites"], saved);
    } catch (err) {
      // Put the truth back rather than leaving the row showing a team that was
      // never saved, and say so.
      void favouritesQuery.refetch();
      toast.error(`Could not save followed teams: ${errorMessage(err)}`);
    }
  }

  function toggle(team: ScoreFavourite): void {
    const key = keyOf(team);
    void save(
      selected.has(key) ? favourites.filter((f) => keyOf(f) !== key) : [...favourites, team],
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-body text-gray-12">Followed teams</span>
          <span className="text-caption1 text-gray-9">
            Their live scores appear in the context bar, on Home, and on any display with a Live
            scores object.
          </span>
        </div>
        <TeamPicker
          league={league}
          onLeague={setLeague}
          teams={teamsQuery.data ?? []}
          loading={teamsQuery.isFetching}
          error={teamsQuery.error ? errorMessage(teamsQuery.error) : null}
          selected={selected}
          onToggle={toggle}
        />
      </div>

      {favouritesQuery.isError && (
        <p className="flex items-start gap-1.5 text-caption1 text-red-11">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span>Could not read the followed teams — {errorMessage(favouritesQuery.error)}</span>
        </p>
      )}

      {favourites.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-a5 px-3 py-4 text-center text-caption1 text-gray-9">
          No teams followed yet. Scores stay off until you add one.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {favourites.map((f) => (
            <li
              key={keyOf(f)}
              className="flex items-center gap-2.5 rounded-md border border-gray-a4 bg-gray-a2 px-2.5 py-1.5"
            >
              <TeamMark team={f} />
              <span className="truncate text-footnote text-gray-12">{f.displayName}</span>
              <span className="ml-auto shrink-0 text-caption2 uppercase tracking-wider text-gray-9">
                {labelForLeague(f.league)}
              </span>
              <button
                type="button"
                aria-label={`Stop following ${f.displayName}`}
                onClick={() => void save(favourites.filter((x) => keyOf(x) !== keyOf(f)))}
                className="shrink-0 rounded p-1 text-gray-9 hover:bg-gray-a3 hover:text-red-11"
              >
                <TrashIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
