// restore-credentials.ts — credentials a config restore would send somewhere new.
//
// A config snapshot never carries a secret: secrets.bin stays on the box. So a
// restore replaces the addresses in settings.json, wireless-connections.json and
// video-feeds.json while every stored credential stays where it was, and the
// boot that follows sends each one to whatever address the bundle named. A
// crafted bundle could point OBS at another machine and collect its password.
//
// So the restore clears, before it writes anything, every stored credential that
// would go somewhere other than where it was entered for, by the same rule a save
// follows (credential-target.ts). One the bundle leaves where it was stays.
//
// The live config is read off disk, never through the stores: a restore is
// followed by a restart whose loads must find cold caches, and a store warmed
// here would hand the next load what was there before the restore. A file that
// cannot be read or parsed says nothing about where a credential was entered for,
// so each credential the bundle names in it is cleared as if it had no address:
// the cost of that is a password typed again. One it does not name is left in its
// slot, and a feed created later under that id clears it (videoService.addFeed).
//
// Imported lazily by config-snapshot.ts, which the backup scheduler pulls in at
// boot.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { credentialTargetMoved, describeTarget, type CredentialTarget } from "./credential-target.js";
import { credentialTargetFor, credentialTargetIds } from "./integration-targets.js";
import { scrub } from "./scrub.js";
import { secretsStore } from "./secrets.js";
import { feedSecretSlot } from "./video/feed-id.js";
import { pullCredentialTarget } from "./video/feed-input.js";
import { wirelessCredentialTarget, wirelessSecretSlot } from "./wireless-credentials.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A wireless connection or a feed, as either side of a restore holds it. */
type Entry = Record<string, unknown> & { id: string; name: string };

/** The entries of a list that carry a string id, each named, its id if nothing
 *  else. A list (not a map by id) so a crafted bundle naming one id twice is
 *  judged entry by entry. */
function entriesOf(v: unknown): Entry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.id === "string")
    .map((e) => ({ ...e, id: e.id as string, name: typeof e.name === "string" ? e.name : (e.id as string) }));
}

const configOf = (e: Entry | undefined) => (isRecord(e?.config) ? e.config : {});
const providerOf = (e: Entry | undefined) => (typeof e?.providerId === "string" ? e.providerId : "");
const kindOf = (e: Entry | undefined) => (isRecord(e?.source) ? e.source.kind : undefined);

/** A live config file as it sits on disk, or undefined: see the header. */
async function readLive(name: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(getUserDataPath(), name), "utf8"));
  } catch {
    return undefined;
  }
}

const holdsSecrets = async (slot: string) => Object.keys(await secretsStore.getSecrets(slot)).length > 0;

/** Clear one slot and say so, at once, so a clear that fails later leaves a log
 *  of the ones before it. `to` "removed" is a connection or feed the restore
 *  drops outright. */
async function clear(slot: string, what: string, from: CredentialTarget | null, to: CredentialTarget | null | "removed"): Promise<void> {
  await secretsStore.clearSecrets(slot);
  if (to === "removed") {
    console.warn(`[config-snapshot] cleared the stored credential of ${scrub(what)}: the restore removes it.`);
    return;
  }
  console.warn(
    `[config-snapshot] cleared the stored credential of ${scrub(what)}: the restore moves it from ` +
      `${scrub(describeTarget(from))} to ${scrub(describeTarget(to))}, and a credential is never sent to an address it was not entered for. ` +
      "Enter it again after the restart if the new address needs it.",
  );
}

/**
 * The wireless connections or feeds a restore replaces: each live one the
 * bundle leaves out loses its credential, as deleting one does (left behind, it
 * would be picked up by the next one created under the same id: a feed's id
 * comes from its name), and each one the bundle carries keeps its credential
 * only while `keeps` says so.
 */
async function clearReplaced(
  live: Entry[],
  incoming: Entry[],
  slotOf: (id: string) => string,
  targetOf: (e: Entry) => CredentialTarget | null,
  keeps: (was: Entry | undefined, now: Entry) => boolean,
): Promise<void> {
  const kept = new Set(incoming.map((e) => e.id));
  for (const e of live) {
    if (!kept.has(e.id) && (await holdsSecrets(slotOf(e.id)))) await clear(slotOf(e.id), e.name, targetOf(e), "removed");
  }
  const byId = new Map(live.map((e) => [e.id, e]));
  for (const e of incoming) {
    if (!(await holdsSecrets(slotOf(e.id)))) continue;
    const was = byId.get(e.id);
    if (!keeps(was, e)) await clear(slotOf(e.id), e.name, was ? targetOf(was) : null, targetOf(e));
  }
}

/**
 * Clear every stored credential that the bundle's files would send to a new
 * address. `files` is what the restore is about to write, by today's file
 * names; a file the bundle does not carry is not being replaced, so nothing in
 * it moves.
 *
 * A credential with no live owner, or whose owner the bundle turns into
 * something else (a pull feed into a push feed), is cleared too: nothing says
 * where it was entered for, and a push feed would hand a camera's password out
 * as its publish password.
 */
export async function clearCredentialsARestoreMoves(files: ReadonlyMap<string, unknown>): Promise<void> {
  const settings = files.get("settings.json");
  if (isRecord(settings)) {
    const liveSettings = await readLive("settings.json");
    const live = isRecord(liveSettings) && isRecord(liveSettings.integrationConfigs) ? liveSettings.integrationConfigs : {};
    const next = isRecord(settings.integrationConfigs) ? settings.integrationConfigs : {};
    // Every secret these integrations hold goes to the target, so the whole
    // slot goes with it.
    for (const id of credentialTargetIds()) {
      if (!(await holdsSecrets(id))) continue;
      const from = credentialTargetFor(id, isRecord(live[id]) ? live[id] : undefined);
      const to = credentialTargetFor(id, isRecord(next[id]) ? next[id] : undefined);
      if (credentialTargetMoved(from, to)) await clear(id, id, from, to);
    }
  }

  const wireless = files.get("wireless-connections.json");
  if (wireless !== undefined) {
    const target = (e: Entry) => wirelessCredentialTarget(providerOf(e), configOf(e));
    await clearReplaced(entriesOf(await readLive("wireless-connections.json")), entriesOf(wireless), wirelessSecretSlot, target, (was, now) =>
      was !== undefined && !credentialTargetMoved(target(was), target(now)),
    );
  }

  const video = files.get("video-feeds.json");
  if (isRecord(video)) {
    const liveFile = await readLive("video-feeds.json");
    const target = (e: Entry) => pullCredentialTarget(e.source);
    await clearReplaced(entriesOf(isRecord(liveFile) ? liveFile.feeds : undefined), entriesOf(video.feeds), feedSecretSlot, target, (was, now) => {
      // A push feed's publish password is this server's own and goes nowhere,
      // so it stays while the feed stays a push feed. Anything else keeps its
      // password only while it pulls from the same place.
      if (kindOf(was) === "push" && kindOf(now) === "push") return true;
      return was !== undefined && kindOf(was) === kindOf(now) && target(was) !== null && !credentialTargetMoved(target(was), target(now));
    });
  }
}
