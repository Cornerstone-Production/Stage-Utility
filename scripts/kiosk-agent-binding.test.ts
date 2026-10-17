// What each kiosk agent remembers as its server, and where it goes, run for real.
//
// The launcher each installer writes keeps the server it is set up on in a
// `bound-to` file and sends it in every probe as `boundTo`, and every other server
// ignores a screen that names somebody else. So the file must hold a server that
// said this screen is set up there, and lose it when that server says it no longer
// is — or a screen released on one server can never be set up on another.
//
// Each launcher is rendered from its installer exactly as the installer renders it,
// and its own discovery loop is run with only the network stubbed: each probe is
// answered with replies from the helper's release-handover fixture, which the
// server's responder test proves the server sends. Nothing past the loop runs (no
// browser is opened).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "helper/macos/Fixtures/release-handover.json"), "utf8")) as {
  servers: Record<"a" | "b", { url: string }>;
  replies: Record<"aClaimed" | "aReleased" | "bUnclaimed" | "bClaimed", string>;
};
const R = FIXTURE.replies;
const A = FIXTURE.servers.a.url;
const B = FIXTURE.servers.b.url;
/** A server older than the reply's `claimed` field. */
const OLD = R.aClaimed.replace(',"claimed":true', "");
assert.notEqual(OLD, R.aClaimed, "the fixture's aClaimed no longer ends in claimed:true");
const FORGOT = "[kiosk] server srv-a no longer has this screen set up; forgot it, so any server can set it up";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-binding-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r.status, 0, `${cmd} failed: ${r.stderr}`);
  return { out: r.stdout, err: r.stderr };
}

/** The first group `re` matches in an installer, which must match. */
function between(script: string, re: RegExp): string {
  const m = re.exec(fs.readFileSync(path.join(ROOT, "scripts/kiosk", script), "utf8"));
  assert.ok(m, `${script} has no launcher`);
  return m[1];
}

/** The launcher's lines from the first to the one before `stop`, with `stub` put in
 *  just before the line that starts with `at`. Both lines must be there. */
function cut(launcher: string, at: string, stop: string, stub: string): string {
  const lines = launcher.split("\n");
  const from = lines.findIndex((l) => l.startsWith(at));
  const to = lines.findIndex((l, i) => i > from && l.startsWith(stop));
  assert.ok(from >= 0 && to > from, `the launcher has no ${at} ... ${stop}`);
  return [...lines.slice(0, from), stub, ...lines.slice(from, to)].join("\n");
}

/** One boot's discovery: the address it settled on, what each probe carried as
 *  boundTo ("-" for none), what is in bound-to after, and what it logged. */
interface Boot {
  url: string;
  probes: string[];
  bound: string | null;
  log: string;
}

/** Boot once in a fresh state folder holding `bound`; probe n is answered with
 *  `answers[n]`, every reply heard in that probe's two seconds, or by nobody. */
type Agent = (bound: string | null, answers: string[][]) => Boot;

function boot(once: (dir: string) => { out: string; err: string }): Agent {
  return (bound, answers) => {
    const dir = fs.mkdtempSync(path.join(TMP, "state-"));
    fs.writeFileSync(path.join(dir, "device-id"), "dev-1");
    fs.writeFileSync(path.join(dir, "token"), "t");
    if (bound) fs.writeFileSync(path.join(dir, "bound-to"), bound);
    answers.forEach((replies, n) => fs.writeFileSync(path.join(dir, `reply.${n}`), replies.join("\n")));
    const { out, err } = once(dir);
    const file = path.join(dir, "bound-to");
    const probes = path.join(dir, "probes");
    return {
      url: /^URL=(.*)$/m.exec(out)?.[1] ?? "",
      probes: fs.existsSync(probes) ? fs.readFileSync(probes, "utf8").trim().split("\n") : [],
      bound: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
      log: err.trim(),
    };
  };
}

/** A bash launcher, rendered the way its `cat <<LAUNCHER` does, with `discover`
 *  replaced: it notes the boundTo it would send and prints that probe's replies
 *  back to back, as they arrive on the socket. */
function bashAgent(script: string): Agent {
  const body = between(script, /<<LAUNCHER\n([\s\S]*?)\nLAUNCHER\n/);
  const stub = [
    "discover() {",
    '  n="$(cat "$STATE_DIR/n" 2>/dev/null || echo 0)"',
    '  echo $((n + 1)) > "$STATE_DIR/n"',
    '  echo "$(cat "$BOUND_FILE" 2>/dev/null || echo -)" >> "$STATE_DIR/probes"',
    '  tr -d "\\n" 2>/dev/null < "$STATE_DIR/reply.$n"',
    "}",
  ].join("\n");
  return boot((dir) => {
    const launcher = run("bash", ["-c", `cat <<LAUNCHER\n${body}\nLAUNCHER`], {
      PATH: process.env.PATH ?? "", STATE_DIR: dir, PORT: "8789",
    }).out;
    const loop = cut(launcher, 'if [ -r "$STATE_DIR/server" ]', "TARGET=", stub);
    return run("bash", ["-c", `${loop}\nprintf 'URL=%s\\n' "$URL"`], { PATH: process.env.PATH ?? "" });
  });
}

/** The PowerShell launcher, rendered from the installer's here-string, with
 *  `Send-Probe` replaced the same way. */
function pwshAgent(): Agent {
  const bodyFile = path.join(TMP, "launcher-body.txt");
  fs.writeFileSync(bodyFile, between("install-windows.ps1", /\n@"\n([\s\S]*?)\n"@ \| Set-Content -Encoding UTF8 \$Launcher/));
  const stub = [
    "$script:n = 0",
    "function Send-Probe($probe) {",
    "  $b = if (Test-Path $boundFile) { Get-Content $boundFile } else { '-' }",
    "  Add-Content (Join-Path $StateDir 'probes') $b",
    "  $f = Join-Path $StateDir \"reply.$($script:n)\"",
    "  $script:n++",
    "  if (Test-Path $f) { Get-Content $f }",
    "}",
  ].join("\n");
  return boot((dir) => {
    const launcher = run("pwsh", [
      "-NoProfile", "-Command",
      `$StateDir = '${dir}'; $Port = 8789; $ExecutionContext.InvokeCommand.ExpandString((Get-Content -Raw '${bodyFile}'))`,
    ]).out;
    const loop = cut(launcher, "if (Test-Path $serverFile)", "$target =", stub);
    // Write-Host goes to the information stream; 6>&1 is not wanted, so it is
    // mirrored to stderr for the log check.
    const script = path.join(dir, "loop.ps1");
    fs.writeFileSync(script, `function Write-Host($m) { [Console]::Error.WriteLine($m) }\n${loop}\n"URL=$url"`);
    return run("pwsh", ["-NoProfile", "-File", script]);
  });
}

const LAUNCHERS: { name: string; make: () => Agent; skip?: string | false; olderServerRemembered: boolean }[] = [
  { name: "install-linux.sh", make: () => bashAgent("install-linux.sh"), olderServerRemembered: false },
  { name: "install-macos.sh", make: () => bashAgent("install-macos.sh"), olderServerRemembered: true },
  {
    name: "install-windows.ps1", make: pwshAgent, olderServerRemembered: true,
    skip: !has("pwsh") && "pwsh is not installed",
  },
];

for (const { name, make, skip, olderServerRemembered } of LAUNCHERS) {
  describe(`the ${name} launcher`, { skip }, () => {
    const agent: Agent = skip ? () => ({ url: "", probes: [], bound: null, log: "" }) : make();

    it("released, forgets its server and goes to one with its Screens page open in the same boot", () => {
      assert.deepEqual(agent("srv-a", [[R.aReleased], [R.bUnclaimed]]), {
        url: B, probes: ["srv-a", "-"], bound: null, log: FORGOT,
      });
    });

    it("released with nobody else answering, forgets its server and shows the old one's holding screen", () => {
      assert.deepEqual(agent("srv-a", [[R.aReleased]]), { url: A, probes: ["srv-a", "-"], bound: null, log: FORGOT });
    });

    it("remembers a server that says this screen is set up there", () => {
      assert.deepEqual(agent(null, [[R.aClaimed]]), { url: A, probes: ["-"], bound: "srv-a", log: "" });
    });

    it("does not remember a server that merely answered", () => {
      assert.deepEqual(agent(null, [[R.bUnclaimed]]), { url: B, probes: ["-"], bound: null, log: "" });
    });

    it("keeps the server it remembers when another says it is not set up there", () => {
      assert.equal(agent("srv-a", [[R.bUnclaimed]]).bound, "srv-a");
    });

    it("takes the answer from the server it remembers over any other", () => {
      assert.deepEqual(agent("srv-a", [[R.bClaimed, R.aClaimed]]), { url: A, probes: ["srv-a"], bound: "srv-a", log: "" });
    });

    it("takes the answer from a server it is set up on when two answer at once", () => {
      assert.deepEqual(agent(null, [[R.bUnclaimed, R.aClaimed, R.bUnclaimed]]), {
        url: A, probes: ["-"], bound: "srv-a", log: "",
      });
    });

    it(`${olderServerRemembered ? "remembers" : "does not remember"} a server that sends no claimed`, () => {
      assert.deepEqual(agent(null, [[OLD]]), {
        url: A, probes: ["-"], bound: olderServerRemembered ? "srv-a" : null, log: "",
      });
    });
  });
}
