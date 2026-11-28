// zones.ts — a server clock a day apart from the browser running the test.
//
// The app dates things in its server's zone when none is set, and a test that
// checks that has to see the server's answer differ from the browser's. Which
// zone does depends on where the test runs, so this picks one: either side of
// the date line, one of the two is always on another calendar day.

import { hostTimeZone, zonedDateKey } from "@main/services/app-timezone";

/** A zone on which the instant `at` falls on a different day than in this
 *  browser's own zone (and so at a different time of day too). */
export function serverZoneApartFromBrowser(at: string | number): string {
  const ms = typeof at === "number" ? at : Date.parse(at);
  const browser = zonedDateKey(ms, hostTimeZone());
  const zone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find((z) => zonedDateKey(ms, z) !== browser);
  if (!zone) throw new Error("no zone dates this instant apart from the browser's");
  return zone;
}
