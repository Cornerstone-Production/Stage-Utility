// capture/index.ts — take the screenshots, week-phase shots first, then live.

import { until, type Api } from "../lib/api.ts";
import { Session, launch } from "./kit.ts";
import { SHOTS, type World } from "./shots.ts";

export async function capture({
  base,
  api,
  world,
  only,
  outDir,
  setLive,
}: {
  base: string;
  api: Api;
  world: World;
  only: string[] | null;
  outDir: string;
  setLive: (live: boolean) => void;
}) {
  const wanted = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  const unknown = (only ?? []).filter((n) => !SHOTS.some((s) => s.name === n));
  if (unknown.length > 0) throw new Error(`no such image: ${unknown.join(", ")}`);

  const session = new Session(await launch(), base, outDir);
  const failures: { name: string; error: string }[] = [];
  try {
    await session.openScreens(Object.values(world.outputs));
    const page = await session.appPage();

    for (const phase of ["week", "live"]) {
      const shots = wanted.filter((s) => s.phase === phase);
      if (shots.length === 0) continue;
      if (phase === "live") {
        // The service that is on is a plan of its own (see world.ts liveWeekendPlan).
        setLive(true);
        await api.post("/api/refresh"); // a manual refresh drops the cached plan list
        await api.post("/api/plan", { id: world.livePlanId });
        await until(async () => (await api.get("/api/pco/live"))?.mode === "item", "the live item to start");
        // Let every screen and the recorders see it.
        await page.waitForTimeout(6000);
      }
      console.log(`${phase} shots`);
      for (const shot of shots) {
        try {
          await shot.run({ session, page, api, world });
        } catch (err) {
          failures.push({ name: shot.name, error: (err as Error).message });
          console.error(`  ${shot.name}: FAILED: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    await session.close();
  }

  const over = session.written.filter((w) => w.bytes > 250 * 1024);
  console.log(`${session.written.length} image(s) written to ${outDir}`);
  if (over.length > 0) console.warn(`over 250 KB: ${over.map((o) => o.name).join(", ")}`);
  if (failures.length > 0) throw new Error(`${failures.length} image(s) failed: ${failures.map((f) => f.name).join(", ")}`);
}
