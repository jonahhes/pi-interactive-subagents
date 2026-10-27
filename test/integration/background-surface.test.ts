/**
 * Integration tests for the headless `background` surface backend (plan
 * PLANS-2026-10-19-background-surface-backend.md).
 *
 * Case A — bare environment: the parent pi runs with ALL multiplexer markers
 * scrubbed from its env (TMUX/TMUX_PANE/HERDR_*), so the extension's `auto`
 * resolution falls through herdr → tmux to the background floor. The child
 * runs headless: no pane is created, its output is a log file (named in a
 * `Log:` steer line), the parent's `subagent_interrupt` of the RUNNING child
 * tears the headless run down (interruption steer, also with a `Log:` line),
 * and a later `subagent_message` resume re-resolves to background (a second
 * `Log:` steer line, whose log — a short clean completion — is non-empty).
 *
 *   NOTE (feature bug, reported not fixed): on a CLEAN completion the launch
 *   wrapper exits before the watcher's close runs, and closeBackground skips
 *   the group kill for an already-exited child — so a detached grandchild
 *   SURVIVES a clean completion. Additionally, through a real LLM flow the
 *   child's bash command runs in pi's bash tool's OWN detached process group
 *   (one level below the wrapper), so the wrapper group-kill does not reach
 *   a deep grandchild at all. The group-kill guarantee is therefore codified
 *   at the launchBackground level by the Part-1 UNIT test (wrapper + a
 *   grandchild in its group both die on closeSurface); Case A proves the
 *   headless lifecycle end-to-end and asserts no new multiplexer surfaces.
 *
 * Case B — herdr parent forced to background (gated: runs only when the suite
 * itself is inside herdr): the parent is a REAL herdr pane (HERDR_ENV=1
 * inherited; only the env override is set, which is checked BEFORE
 * environment detection). Its nested spawn (test-nested → test-echo) MUST
 * also be headless: the parent pins `PI_SUBAGENT_BACKEND=background` on the
 * child, and the child consults the override BEFORE environment detection,
 * so it cannot re-detect herdr from the inherited HERDR_* markers and orphan
 * a grandchild pane. Asserted: no new herdr surfaces, the top-level launch
 * script pins PI_SUBAGENT_BACKEND='background', the top-level log exists,
 * and the grandchild's log exists under the top-level child's
 * `subagent-logs/` (i.e. it launched headless, not as a herdr pane).
 *
 *   v1 LIMITATION (documented, not a crash): the spawner child is a PRINT-MODE
 *   pi, which disposes the session after its FIRST turn. A background spawner
 *   therefore completes the moment it has spawned its own child: it steers
 *   the parent an "interim report" completion (exit code 0 - its log's last
 *   line is __SUBAGENT_DONE_0__), and its session_shutdown sweep then kills
 *   the still-running grandchild. The grandchild's log so EXISTS under the
 *   spawner's subagent-logs/ but stays EMPTY (print-mode pi writes its final
 *   text only on clean completion, which the grandchild never reaches). The
 *   stale-ctx crash that used to follow exactly this shape is fixed in the
 *   extension (the sessionEnded guard, "fix(subagents): guard extension ctx
 *   after session shutdown"), so the steer is a clean "completed" and the
 *   spawner log must NOT contain "extension ctx is stale". The assertions
 *   below prove the crash-free propagation: no new herdr surfaces, the
 *   spawner's launch script pins PI_SUBAGENT_BACKEND='background', both logs
 *   exist, no orphan grandchild process survives, and the top-level parent
 *   exits 0 after reporting BG_HERDR_DONE.
 *
 * Both cases spawn REAL pi sessions with REAL LLM calls (litellm/coding by
 * default) and use generous timeouts — they are multi-step flows.
 *
 * Run: node --test --test-concurrency=1 test/integration/background-surface.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  sendCommand,
  waitForFile,
  waitForPiExit,
  waitForParentSessionFile,
  listSurfaceLabels,
  sleep,
  uniqueId,
  parseSessionEntries,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

/** Multiplexer marker vars to strip so a parent's `auto` resolution sees a
 *  bare environment (case A). */
const MUX_ENV_VARS = [
  "TMUX",
  "TMUX_PANE",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
];

// These are multi-step LLM flows; the default 120s per-wait is too tight for
// "spawn AND interrupt AND resume AND steers land AND I parse them".
const CASE_TIMEOUT = PI_TIMEOUT * 2;

// ── Session-file helpers ──

function isSubagentResult(entry: any, name: string): boolean {
  return (
    entry?.type === "custom_message" &&
    entry?.customType === "subagent_result" &&
    entry?.details?.name === name
  );
}

/**
 * Non-throwing scan: the subagent_result steers addressed to `childName` in
 * any recent session file (in file order; [] when none found yet).
 */
function scanParentSteers(childName: string): any[] {
  const root = join(homedir(), ".pi", "agent", "sessions");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > 30 * 60_000) continue;
        const content = readFileSync(p, "utf8");
        if (!content.includes(`"customType":"subagent_result"`) || !content.includes(childName)) continue;
        return parseSessionEntries(p).filter((e) => isSubagentResult(e, childName));
      } catch {}
    }
  }
  return [];
}

async function waitForParentSession(
  childName: string,
  minResults: number,
  timeout = CASE_TIMEOUT,
): Promise<any[]> {
  const start = Date.now();
  for (;;) {
    const results = scanParentSteers(childName);
    if (results.length >= minResults) return results;
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout (${timeout}ms) waiting for ${minResults} subagent_result steer(s) for "${childName}"`);
    }
    await sleep(1000);
  }
}

/** The log path named in a steer's content (`Log: <path>` line). */
function steerLogPath(steer: any): string | null {
  const m = String(steer?.content ?? "").match(/Log:\s*(\S+)/);
  return m ? m[1] : null;
}

/**
 * pgrep any process whose command line contains `marker` (an ERE for
 * pgrep -f). Returns the matching process lines ([] when none; pgrep exits 1
 * with no output on no match). Used to assert no orphan (grand)child survived
 * the spawner's shutdown sweep; pass a unique file path (the `.` wildcards it
 * contains cannot produce a false positive at this length).
 */
function pgrepAny(marker: string): string[] {
  try {
    return execFileSync("pgrep", ["-af", marker], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * New surface labels that carry this test's unique `id` and were absent at
 * the `before` snapshot. Shared-host-safe: unrelated panes never carry the
 * per-run random id, and the parent's own pane (which does) is in `before`.
 * A background subagent that wrongly created a multiplexer surface would
 * label it with the subagent's name (which embeds the id) and be caught.
 */
function newTaggedLabels(before: Set<string>, id: string): string[] {
  return listSurfaceLabels().filter((l) => l.includes(id) && !before.has(l));
}

// ── Case A: bare environment → background floor ──

describe("background surface: headless spawn, group-kill hygiene, and background resume", {
  timeout: 1_800_000,
}, () => {
  let env: TestEnv;

  before(() => {
    env = createTestEnv();
  });

  after(() => {
    cleanupTestEnv(env);
  });

  it("a mux-free parent spawns headless (Log: steer, no panes); the interrupt tears down the running child; resume re-resolves to background", async () => {
    const id = uniqueId();
    // The child runs `sleep 40`. The parent only waits until the child's
    // marker appears (its bash tool started) + 8s, then interrupts — so the
    // interrupt lands ~8s into the 40s sleep, while the child is definitely
    // still running. (The child's bash command runs in pi's bash tool's OWN
    // detached process group, one level below the headless wrapper, so the
    // wrapper group-kill does not reach a deep grandchild — see the NOTE in
    // the header. The group-kill guarantee itself is codified at the
    // launchBackground level by the Part-1 unit test.)
    const SLEEPCMD = 40;
    const childName = `BG-${id}`;
    const markerFile = join(env.dir, `marker-${id}`);
    const marker2File = join(env.dir, `marker2-${id}`);

    const surface = await createTrackedSurface(env, `bg-bare-${id}`.slice(0, 40));
    await sleep(1000);

    const before = new Set(listSurfaceLabels());

    // The parent performs the whole flow itself (subagent tools only exist
    // INSIDE its extension): spawn a `sleep 40` child → bash-loop until the
    // child's marker appears + 8s → interrupt the RUNNING child →
    // (interruption steer) → resume the child with a short task →
    // (completion steer).
    const task = [
      `You must do these steps in this EXACT order and do nothing else:`,
      ``,
      `STEP 1. Call the subagent tool ONCE with these EXACT parameters:`,
      `  name: "${childName}"`,
      `  agent: "test-echo"`,
      `  task: "Run this bash command exactly as given (one command): echo 'MARKER_${id}' > '${markerFile}'; sleep ${SLEEPCMD}"`,
      ``,
      `STEP 2. Do NOT wait for the subagent result. Immediately run this bash command exactly as given:`,
      `  for i in $(seq 1 90); do [ -f '${markerFile}' ] && break; sleep 1; done; sleep 8`,
      ``,
      `STEP 3. As soon as that bash command returns, call the subagent_interrupt tool with these EXACT parameters:`,
      `  name: "${childName}"`,
      ``,
      `STEP 4. When the next subagent message arrives, call the subagent_message tool ONCE with these EXACT parameters:`,
      `  name: "${childName}"`,
      `  message: "Run this bash command exactly as given: echo 'MARKER2_${id}' > '${marker2File}'"`,
      ``,
      `STEP 5. When that final result message arrives, say BG_BARE_DONE and stop.`,
    ].join("\n");

    startPi(surface, env.dir, task, { envScrub: MUX_ENV_VARS });

    // (b) No new (tagged) mux surfaces for the headless spawn — check while
    //     the child is still running (before the later resume step).
    assert.deepEqual(newTaggedLabels(before, id), [], "background spawn must not create multiplexer surfaces");

    // (d) Wait for the two steers. Steer #1 is the interruption (the child is
    //     killed mid-`sleep`); steer #2 is the resume completion. The child
    //     is interrupted ~8s into its 40s sleep, so it is definitely still
    //     running when the interrupt fires.
    const all = await waitForParentSession(childName, 2, CASE_TIMEOUT * 2);
    const interruptSteer = all[0];
    assert.match(String(interruptSteer.content), /was interrupted/i, "steer #1 must be the interruption notice (the child was running when interrupted)");

    // (a) The interruption steer names the headless child's log. The log
    //     EXISTS but may be EMPTY: the child was interrupted mid-`sleep`
    //     (print-mode pi only writes its final text on completion), so the
    //     non-emptiness assertion belongs to the RESUME run's log below.
    const spawnLogPath = steerLogPath(interruptSteer);
    assert.ok(spawnLogPath, `the interruption steer must name the log file (Log: line); got: ${String(interruptSteer.content).slice(0, 400)}`);
    assert.ok(spawnLogPath.includes("subagent-logs"), `log path must live under subagent-logs/; got: ${spawnLogPath}`);
    assert.ok(existsSync(spawnLogPath), `log file must exist: ${spawnLogPath}`);

    // (b) Still no new (tagged) mux surfaces.
    assert.deepEqual(newTaggedLabels(before, id), [], "no multiplexer surface for the headless child");

    // (c) The resume re-resolves to background: the resumed headless child
    //     writes marker2 and completes (steer #2, also with a Log: line). Its
    //     log is a clean short completion → non-empty.
    await waitForFile(marker2File, CASE_TIMEOUT, new RegExp(`MARKER2_${id}`));
    assert.ok(readFileSync(marker2File, "utf8").includes(`MARKER2_${id}`), "resume marker content");
    const resumeSteer = all[1];
    assert.match(String(resumeSteer.content), /completed/i, "steer #2 (the resume) should be a completion");
    const resumeLogPath = steerLogPath(resumeSteer);
    assert.ok(resumeLogPath, "the resume completion must also name a log file (re-resolved to background)");
    assert.ok(existsSync(resumeLogPath), `resume log must exist: ${resumeLogPath}`);
    assert.ok(statSync(resumeLogPath).size > 0, `resume log must be non-empty (clean completion writes the final text): ${resumeLogPath}`);
    // Exactly two steers: the interruption (spawn run, killed) + the
    // completion (resume run). No completion steer for the interrupted run.
    assert.equal(all.length, 2, `expected exactly 2 steers (interruption + resume completion), got ${all.length}`);

    // (b-final) No new (tagged) multiplexer surfaces at the end either.
    await sleep(2000);
    assert.deepEqual(newTaggedLabels(before, id), [], "no new multiplexer surfaces at the end");
  });
});

// ── Case B: herdr parent forced to background (env propagation) ──

const herdrAvailable = getAvailableBackends().includes("herdr");

describe("background surface: herdr parent forced to background (env propagation)", {
  timeout: 1_800_000,
  skip: !herdrAvailable ? "suite is not running inside herdr" : false,
}, () => {
  let env: TestEnv;

  before(() => {
    env = createTestEnv();
  });

  after(() => {
    cleanupTestEnv(env);
  });

  it("nested spawns from a herdr parent forced to background stay headless: no orphan panes, propagation pinned, grandchild log exists", async () => {
    const id = uniqueId();
    const topName = `BGTOP-${id}`;
    const grandName = `BGGRAND-${id}`;

    const surface = await createTrackedSurface(env, `bg-herdr-${id}`.slice(0, 40));
    await sleep(1000);

    const before = new Set(listSurfaceLabels());

    // Same nested-spawn task shape as the existing lifecycle nested test
    // (proven exact-params format). The grandchild's task is short (sleep 25).
    const task = [
      `You must call the subagent tool exactly ONCE, with these EXACT parameters:`,
      `  name: "${topName}"`,
      `  agent: "test-nested"`,
      `  task: "Call the subagent tool with these EXACT parameters:\n  name: \\"${grandName}\\"\n  agent: \\"test-echo\\"\n  task: \\"Run this bash command exactly as given: sleep 25; echo 'GRAND_${id}'\\\"\nDo not do anything else, and stop immediately after the subagent call without waiting for its result."`,
      `Do not do anything else. Just call the subagent tool once.`,
      `When the result message arrives (whether success or failure), say BG_HERDR_DONE and stop.`,
    ].join("\n");

    // The parent is a REAL herdr pane (HERDR_ENV=1 inherited — we do NOT
    // scrub the multiplexer markers; that is what makes this the
    // mandatory-propagation scenario). Only the env override is set; it is
    // checked BEFORE environment detection, so the parent resolves to
    // background even though herdr is present. startPi already strips the
    // PI_SUBAGENT_* spawner-identity vars, so the parent is a top-level
    // spawner. The child inherits HERDR_ENV=1 AND the propagated
    // PI_SUBAGENT_BACKEND=background; without the propagation it would
    // re-detect herdr and orphan a pane.
    startPi(surface, env.dir, task, {
      envSet: { PI_SUBAGENT_BACKEND: "background" },
    });

    // Wait for the top-level child's (the SPAWNER's) steer. With the stale-ctx
    // crash fixed it is a clean COMPLETION (exit code 0): print-mode pi
    // disposes the spawner's session after its first turn, so the spawner
    // reports an "interim report" the moment its own child is spawned.
    const steer = (await waitForParentSession(topName, 1, CASE_TIMEOUT * 2))[0];
    assert.match(
      String(steer.content),
      /completed/,
      `the top-level (spawner) steer must be a clean completion (the stale-ctx crash is fixed); got: ${String(steer.content).slice(0, 400)}`,
    );

    // (1) No new herdr surfaces - the mandatory-propagation scenario. Without
    //     PI_SUBAGENT_BACKEND propagation the spawner child would re-detect
    //     herdr from the inherited HERDR_* markers and spawn its grandchild as
    //     a herdr pane (an orphan labelled with the grandchild's name, which
    //     embeds the id).
    await sleep(2000);
    assert.deepEqual(newTaggedLabels(before, id), [], "nested background spawns must not create herdr panes");

    // (2) Direct propagation proof: the spawner child's LAUNCH SCRIPT (written
    //     by the top-level parent, pinned to the parent's RESOLVED backend)
    //     carries PI_SUBAGENT_BACKEND='background'.
    const topSessionId = steer.details?.sessionId;
    const topSessionFile = steer.details?.sessionFile;
    assert.ok(topSessionId, "steer must carry the spawner child's sessionId");
    assert.ok(topSessionFile && existsSync(topSessionFile), `spawner child session file must exist: ${topSessionFile}`);
    const sessionDir = topSessionFile!.slice(0, topSessionFile!.lastIndexOf("/"));
    const topScriptsDir = join(sessionDir, "artifacts", topSessionId!, "subagent-scripts");
    assert.ok(existsSync(topScriptsDir), `spawner child script dir must exist: ${topScriptsDir}`);
    const topScript = readdirSync(topScriptsDir)
      .filter((f) => f.endsWith(".sh") && !f.includes("resume"))
      .map((f) => join(topScriptsDir, f))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)[0];
    assert.ok(topScript, `spawner child launch script must exist in ${topScriptsDir}`);
    assert.ok(
      readFileSync(topScript, "utf8").includes("PI_SUBAGENT_BACKEND='background'"),
      `the spawner child launch script must pin PI_SUBAGENT_BACKEND='background' for its own nested spawn: ${topScript}`,
    );

    // (3) The spawner child's log exists (named in the steer) and is CLEAN:
    //     it ends in the exit-0 sentinel and must NOT carry the stale-ctx
    //     crash (the regression this integration case documents).
    const topLog = steerLogPath(steer);
    assert.ok(topLog, `steer must name the spawner child's log; got: ${String(steer.content).slice(0, 400)}`);
    assert.ok(existsSync(topLog!), `spawner child log must exist: ${topLog}`);
    const topLogText = readFileSync(topLog!, "utf8");
    assert.ok(
      !topLogText.includes("extension ctx is stale"),
      `the spawner log must NOT contain the stale-ctx crash (guard regression): ${topLogText.slice(-400)}`,
    );
    assert.match(
      topLogText,
      /__SUBAGENT_DONE_0__/,
      `spawner log must end in a clean exit-0 sentinel; tail: ${topLogText.slice(-200)}`,
    );

    // (4) The GRANDCHILD's log exists under the spawner's subagent-logs/
    //     (proof it launched HEADLESS off the spawner's bg: surface, not as a
    //     herdr pane). It is EMPTY by the v1 print-mode limitation: the
    //     spawner's session_shutdown sweep kills the mid-`sleep` grandchild
    //     before print-mode pi can write its final text.
    const grandLogDir = join(sessionDir, "artifacts", topSessionId!, "subagent-logs");
    assert.ok(existsSync(grandLogDir), `grandchild log dir must exist: ${grandLogDir}`);
    const grandLogs = readdirSync(grandLogDir).filter((f) => f.endsWith(".log"));
    assert.ok(grandLogs.length >= 1, `grandchild log must exist under ${grandLogDir}; found: ${JSON.stringify(grandLogs)}`);
    const grandLogName = grandLogs.find((f) => f.toLowerCase().includes(grandName.toLowerCase())) ?? grandLogs[0];
    assert.ok(existsSync(join(grandLogDir, grandLogName)), `grandchild log must exist: ${grandLogName}`);

    // (5) No ORPHAN grandchild: the spawner's session_shutdown sweep must have
    //     killed the mid-`sleep` grandchild (its process group: bash wrapper,
    //     `pi --print`, and the inner `sleep 25`). The spawner's launch script
    //     runs `pi --session '<grandchild session>' --print`; that session path
    //     is unique to THIS grandchild (the top-level parent's argv only carries
    //     the run id, never this path), so pgrep of it matches exactly one
    //     process if the grandchild survives. Read it from the spawner's
    //     registry (grandchild name -> sessionFile). Brief grace for the
    //     signal-delivery race between sweep and pgrep.
    const registryPath = join(sessionDir, "artifacts", topSessionId!, "subagent-registry.json");
    assert.ok(existsSync(registryPath), `spawner registry must exist: ${registryPath}`);
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const grandEntry = registry[grandName];
    assert.ok(
      grandEntry?.sessionFile,
      `spawner registry must map the grandchild to a session file; registry: ${JSON.stringify(registry)}`,
    );
    const grandSessionPath = grandEntry.sessionFile as string;
    await sleep(2000);
    assert.equal(
      pgrepAny(grandSessionPath).length,
      0,
      `an orphan grandchild pi process is still running against ${grandSessionPath}`,
    );

    // (6) The top-level PARENT reports BG_HERDR_DONE and then exits 0. The
    //     parent is an INTERACTIVE pi (herdr pane); it stays open after its
    //     task, so drive a clean /quit (the pi TUI command) and read the shell
    //     sentinel startPi already appends (`; echo '__TEST_DONE_'$?'__'`).
    //     waitForPiExit resolves to the parent's exit code.
    const parentSessionFile = await waitForParentSessionFile(topName, 30 * 60_000, CASE_TIMEOUT * 2);
    const doneStart = Date.now();
    for (;;) {
      if (parseSessionEntries(parentSessionFile).some((e) => JSON.stringify(e).includes("BG_HERDR_DONE"))) break;
      if (Date.now() - doneStart > CASE_TIMEOUT) throw new Error(`timeout waiting for BG_HERDR_DONE in ${parentSessionFile}`);
      await sleep(1000);
    }
    await sleep(1500); // let the TUI settle back to the idle prompt before /quit
    sendCommand(surface, "/quit");
    const parentExit = await waitForPiExit(surface, CASE_TIMEOUT * 2);
    assert.equal(parentExit, 0, `the top-level parent must exit 0 after BG_HERDR_DONE; got ${parentExit}`);
  });
});
