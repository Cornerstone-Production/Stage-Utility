// person-directory.ts — Planning Center people a by-person slot names but the
// plan's roster does not have.
//
// A by-person slot shows its person whether or not they are scheduled. When they
// are, the roster has them; when they are not, their name and photo are read from
// Planning Center by ID, once, and kept here. Resolution runs on every broadcast,
// so asking is a map lookup and fetching happens at most once per ID:
//
//  - one read in flight per ID;
//  - a failed read is retried no sooner than RETRY_MS later, and logged once per
//    attempt, so an unreachable PCO costs one line and one request per ID per
//    window, not one per broadcast;
//  - an ID PCO says does not exist (404) is remembered and not asked again until
//    the directory is reset (new credentials) or the server restarts.
//
// This is a best-effort cache in front of a display, so a failure is logged and
// retried rather than thrown: the slot stays empty meanwhile, and /log says why.

import { scrub } from "./scrub.js";
import type { PersonCardDTO } from "../types/stage.js";
import { errorMessage } from "./errors.js";

export const RETRY_MS = 10 * 60_000;

export class PersonDirectory {
  private readonly known = new Map<string, PersonCardDTO>();
  private readonly missing = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private generation = 0;

  constructor(
    /** Reads one person; null for "no such person". Throws on failure. Null
     *  itself when there are no PCO credentials, so nothing is fetched. */
    private readonly read: () => ((id: string) => Promise<PersonCardDTO | null>) | null,
    /** Called when a read lands with a person, so slots re-resolve. */
    private readonly onLanded: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What has been read. Resolution looks names up here. */
  get people(): ReadonlyMap<string, PersonCardDTO> {
    return this.known;
  }

  /** Make sure each of these normalised IDs is read, unless it is already known,
   *  in flight, known missing, or inside its retry window. */
  want(ids: Iterable<string>): void {
    const read = this.read();
    if (!read) return;
    for (const id of ids) {
      if (this.known.has(id) || this.missing.has(id) || this.inflight.has(id)) continue;
      const failed = this.failedAt.get(id);
      if (failed !== undefined && this.now() - failed < RETRY_MS) continue;
      this.fetch(id, read);
    }
  }

  /** Forget everything: the credentials changed, so every answer may differ. */
  reset(): void {
    this.generation++;
    this.known.clear();
    this.missing.clear();
    this.failedAt.clear();
    this.inflight.clear();
  }

  private fetch(id: string, read: (id: string) => Promise<PersonCardDTO | null>): void {
    const generation = this.generation;
    this.inflight.add(id);
    read(id).then(
      (card) => {
        if (generation !== this.generation) return;
        this.inflight.delete(id);
        this.failedAt.delete(id);
        if (card) {
          this.known.set(id, card);
          this.onLanded();
        } else {
          this.missing.add(id);
          console.warn(`[pco] no Planning Center person ${scrub(id)}; a slot linked to that ID stays empty`);
        }
      },
      (err: unknown) => {
        if (generation !== this.generation) return;
        this.inflight.delete(id);
        this.failedAt.set(id, this.now());
        console.warn(
          `[pco] could not read Planning Center person ${scrub(id)}; retrying in ${scrub(RETRY_MS / 60_000)} min: ${scrub(errorMessage(err))}`,
        );
      },
    );
  }
}
