// child.mjs — stands in for the updater doing real work after its parent dies.
//
// Writes a tick a second and a FINISHED marker at the end. The test is simply
// whether FINISHED appears once the service that spawned it has been torn down.

import fs from "node:fs";

const out = process.env.SURVIVAL_LOG;
if (!out) {
  console.error("SURVIVAL_LOG is required");
  process.exit(2);
}

fs.appendFileSync(out, `START pid=${process.pid} ppid=${process.ppid}\n`);

let n = 0;
const timer = setInterval(() => {
  n += 1;
  fs.appendFileSync(out, `tick ${n} ppid=${process.ppid}\n`);
  if (n >= 12) {
    clearInterval(timer);
    fs.appendFileSync(out, "FINISHED\n");
  }
}, 1000);
