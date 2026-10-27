/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (litellm/coding by default).
 * Each test creates a multiplexer pane, runs pi with a task that uses the
 * subagent tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (fast model).
 * Duration: ~30-90s per test.
 *
 * Run inside the multiplexer you want to test (herdr or tmux);
 * the active backend is auto-detected from the environment.
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: litellm/coding)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  copyBundledAgent,
  startPi,
  waitForScreen,
  waitForFile,
  waitForParentSessionFile,
  parseSessionEntries,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No multiplexer available — skipping subagent lifecycle integration tests");
  console.log("   Run inside tmux or herdr to enable these tests.");
}

// ── Nested-child activity-file discovery (file-based, no screen reads) ──

/**
 * Poll until the TOP-LEVEL parent pi's session file is usable for `childName`.
 * The top-level parent (spawned by startPi, never itself a subagent) is the
 * UNIQUE `.jsonl` in the session dir with no `.loadout.json` sidecar (every
 * child's session file has one, written at spawn). By default "usable" = the
 * file already contains the spawn (the child name); with `requireComplete` it
 * must also carry the `subagent_result` steer, i.e. the child has finished.
 * The name embeds a per-run unique id, so it cannot collide with another test.
 */
async function waitForTopLevelSessionFile(
  envDir: string,
  childName: string,
  timeout = PI_TIMEOUT,
  requireComplete = false,
): Promise<string> {
  const safePath = `--${envDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(homedir(), ".pi", "agent", "sessions", safePath);
  const start = Date.now();
  for (;;) {
    let files: string[] = [];
    try {
      files = readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      // The session dir does not exist yet (pi has not started).
    }
    for (const f of files) {
      // A `.loadout.json` sidecar means this session file belongs to a SUBAGENT
      // (written at spawn), not to the top-level parent launched by startPi.
      if (existsSync(join(sessionDir, `${f}.loadout.json`))) continue;
      try {
        const content = readFileSync(join(sessionDir, f), "utf8");
        // The file must already be a real session (header line parses) —
        // parseSessionEntries on a partial file would throw otherwise.
        JSON.parse(content.split("\n", 1)[0]);
        if (content.includes(childName) && (!requireComplete || content.includes(`"customType":"subagent_result"`))) {
          return join(sessionDir, f);
        }
      } catch {}
    }
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timeout (${timeout}ms) finding the top-level parent session file for "${childName}" in ${sessionDir}`,
      );
    }
    await sleep(500);
  }
}

/**
 * Find the nested child's activity file from the parent session file's spawn
 * entries. The parent's `subagent` tool-result for `childName` carries
 * `details.id` (the 8-hex spawn id the child's activity file is named after) and
 * `details.sessionFile`. The file lives at
 * `<sessionsRoot>/<encodedCwd>/artifacts/<parentSessionId>/subagent-activity/<id>.json`.
 */
function findNestedChildActivityFile(
  parentFile: string,
  childName: string,
): { activityFile: string; childId: string } {
  const parentSessionId = (parseSessionEntries(parentFile)[0] as any)?.id;
  const spawnId = parseSessionEntries(parentFile)
    .find(
      (e) =>
        e.type === "message" &&
        e.message?.role === "toolResult" &&
        e.message?.toolName === "subagent" &&
        // NOTE: on message entries the tool-result details live on `message`,
        // not on the entry (top-level `details` is only used by custom_message).
        e.message?.details?.name === childName &&
        typeof e.message?.details?.id === "string" &&
        typeof e.message?.details?.sessionFile === "string" &&
        e.message.details.sessionFile.endsWith(".jsonl"),
    )?.message?.details?.id as string | undefined;
  if (!spawnId) {
    throw new Error(`no successful subagent spawn entry for "${childName}" in ${parentFile}`);
  }
  const sessionDir = dirname(parentFile);
  const activityFile = join(sessionDir, "artifacts", parentSessionId, "subagent-activity", `${spawnId}.json`);
  if (!existsSync(activityFile)) {
    throw new Error(`nested child activity file not found: ${activityFile}`);
  }
  return { activityFile, childId: spawnId };
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed/i,
        // (do NOT also match the persistent launch acknowledgement line
        // `Sub-agent "Status-…" launched. Waiting for its result…` — it is still on
        // screen while the child is mid-`sleep 90`, so a stale pre-completion
        // frame was captured before the completion rendered)
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = await createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Pass EXACTLY the three fields name, agent and task for each call — no other fields.`,
        `Do NOT add a model, thinking or cwd field: the child must run on its default model.`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  agent: "test-fork"`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = await createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });

    // ── Bundled agent (S1/S3 acceptance: the repo's OWN agents/ must work) ──
    //
    // Spawns the repo's REAL bundled `scout` agent (copied from agents/ — the
    // harness only ships test/integration/agents/ by default). The scout is
    // read-only (bash-guard read-only, no write tool), so the MARKER is
    // written by the PARENT only after it receives the scout's completion
    // steer — the marker's existence therefore proves the parent was
    // delivered the result. This proves the bundled definition (with its new
    // `model-fallback: inherit` + codemode frontmatter) spawns and completes
    // on 1.3.0. Note: the `inherit` fallback copies the parent's LIVE thinking
    // level, which pi always resolves to a concrete level (settings default),
    // so a failed primary would NOT hit the same-model skip — the fallback
    // would fire as a same-model retry with the parent's thinking and the
    // steer would carry modelFallback attribution. The assertions below are
    // written to hold on BOTH paths (primary completes → 1 child, no
    // attribution; primary fails + fallback retry → 2 children, attribution,
    // still one final completion steer).

    it("bundled scout agent (model-fallback: inherit) spawns, completes, and steers the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-bundled-scout-${id}.txt`;
      trackTempFile(env, markerFile);
      copyBundledAgent(env, "scout");

      const surface = await createTrackedSurface(env, `scout-${id}`);
      await sleep(1000);

      // The file the (read-only) scout reads.
      writeFileSync(join(env.dir, "small.txt"), `FIRST_${id}\nsecond line\n`, "utf8");

      // Child session dir, mirroring the extension's getDefaultSessionDirFor()
      // path encoding (the child's cwd is the test project dir; no target-
      // local .pi/agent, so the global agent dir holds the sessions). The
      // dir is shared by every child spawned from this env, so we assert on
      // NEW files since the test started (the suite runs sequentially).
      const safePath = `--${env.dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const childSessionDir = join(homedir(), ".pi", "agent", "sessions", safePath);
      const listChildSessions = (): string[] => {
        try {
          return readdirSync(childSessionDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          return [];
        }
      };
      const before = new Set(listChildSessions());

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Scout-${id}"`,
        `  agent: "scout"`,
        `  task: "Read the file small.txt in the current directory and report its first line.",`,
        `Do not do anything else until you receive the subagent result.`,
        `After you receive the subagent result, run: echo 'SCOUT_DONE_${id}' > '${markerFile}'`,
        `Then say SCOUT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The parent writes the marker ONLY after the completion steer arrives —
      // its existence proves the parent was delivered the result.
      const content = await waitForFile(markerFile, PI_TIMEOUT * 2, /SCOUT_DONE_/);
      assert.ok(content.includes(`SCOUT_DONE_${id}`), `marker should contain SCOUT_DONE_${id}`);

      // Authoritative proof of the steer: the parent's session file.
      const parentFile = await waitForParentSessionFile(`Scout-${id}`);
      const entries = parseSessionEntries(parentFile);
      const steers = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === `Scout-${id}`,
      );
      assert.equal(steers.length, 1, "exactly one completion steer for the bundled scout");
      const steer = steers[0];
      assert.equal(steer.details.exitCode, 0, "the bundled scout completed cleanly");
      assert.ok(steer.details.sessionFile && existsSync(steer.details.sessionFile), "the steer names an existing child session file");
      assert.match(steer.content, /completed/i, "the steer is a completion, not a failure");

      // Child session accounting (holds on both fallback paths): at least ONE
      // new CHILD session file — the run the steer names — and at most TWO
      // (a failed primary + its one-shot fallback retry). Children are
      // identified by their .loadout.json sidecar (written at launch); the
      // parent pi's own session file also lives in this dir (one env per
      // suite) and must not be counted. If the fallback fired, the steer
      // carries the attribution and exactly two files exist; otherwise the
      // primary alone completed (one file, no attribution).
      const newChildSessions = listChildSessions().filter(
        (f) => !before.has(f) && existsSync(join(childSessionDir, `${f}.loadout.json`)),
      );
      assert.ok(newChildSessions.length >= 1 && newChildSessions.length <= 2, `child session files in range 1..2 (got ${JSON.stringify(newChildSessions)})`);
      assert.ok(newChildSessions.includes(steer.details.sessionFile.slice(steer.details.sessionFile.lastIndexOf("/") + 1)), "the steer's session file is one of the new child sessions");
      const steerHasAttribution = steer.details.modelFallback != null;
      if (steerHasAttribution) {
        assert.equal(newChildSessions.length, 2, "a fallback retry implies exactly two child sessions (failed primary + retry)");
      } else {
        assert.equal(newChildSessions.length, 1, "no fallback attribution implies exactly one child session (the primary completed)");
      }
    });

    // ── waitingReason observability (#3a) ──
    //
    // A child that spawns its own child and then stops must be PARKED (not
    // exited) until that child's result arrives, and its activity file must
    // report WHY it is waiting: `waitingReason: "own_children"`. This is the
    // incident scenario from the 2026-10-19 diagnosis. File-based assertions
    // only (no readScreen anywhere in this test):
    //   1. wait for the grandchild marker file (its `sleep 20` bash writes it
    //      last) — proves the nested child stayed alive/parked long enough for
    //      its own child to finish;
    //   2. poll the nested child's ACTIVITY FILE (discovered from the parent
    //      session file's spawn entry, see findNestedChildActivityFile) until
    //      it shows phase "waiting" + waitingReason "own_children" — the park
    //      window is ≥20s thanks to the grandchild's `sleep 20`, so this is
    //      reliably observable;
    //   3. at end of test, every activity file under the PARENT's artifact dir
    //      is phase "done" (nested child done; its own child's activity lives
    //      in the nested child's artifact dir, not the parent's).

    it("a child waiting on its own child reports waitingReason own_children in its activity file", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-nested-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `nested-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool exactly ONCE, with these EXACT parameters:`,
        `  name: "nested-${id}"`,
        `  agent: "test-nested"`,
        `  task: "Call the subagent tool with these EXACT parameters:\n  name: \"grand-${id}\"\n  agent: \"test-echo\"\n  task: \"Run this bash command exactly as given: sleep 20; echo 'GRAND_${id}' > '/tmp/pi-integ-nested-${id}.txt'\"\nDo not do anything else, and stop immediately after the subagent call without waiting for its result."`,
        `Do not do anything else. Just call the subagent tool once.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Poll from the start: while the grandchild is mid-`sleep 20` the nested
      // child is PARKED (its turn ended, its child is still running) and its
      // activity file must show phase "waiting" + waitingReason "own_children".
      // The park window is ≥20s, and this polls every 500ms from t=0, so the
      // observation is reliable (no race where the grandchild finishes before
      // the nested child's turn ends). Runs concurrently with the marker-file
      // wait below (Promise.all).
      let sawWaitingOwnChildren = false;
      const parkWindowWait = (async () => {
        const start = Date.now();
        for (;;) {
          try {
            const parentFile = await waitForTopLevelSessionFile(env.dir, `nested-${id}`, 1000);
            const { activityFile } = findNestedChildActivityFile(parentFile, `nested-${id}`);
            const a = JSON.parse(readFileSync(activityFile, "utf8"));
            if (a.phase === "waiting" && a.waitingReason === "own_children") {
              sawWaitingOwnChildren = true;
              return;
            }
          } catch {}
          if (Date.now() - start > PI_TIMEOUT) {
            throw new Error(
              `Timeout (${PI_TIMEOUT}ms) observing the nested child's activity file in ` +
                `phase "waiting" with waitingReason "own_children" during the park window ` +
                `(grandchild still running)`,
            );
          }
          await sleep(500);
        }
      })();

      // Wait for the grandchild marker file (its bash writes it AFTER `sleep 20`).
      // Its existence proves the nested child stayed parked (alive, not exited)
      // long enough for its own child to finish.
      const markerWait = waitForFile(markerFile, PI_TIMEOUT * 2, /GRAND_/);

      const [, content] = await Promise.all([parkWindowWait, markerWait]);
      assert.ok(content.includes(`GRAND_${id}`), `Marker file should contain GRAND_${id}. Got: ${content.trim()}`);
      assert.ok(sawWaitingOwnChildren, "nested child must be observed waiting with waitingReason own_children");

      // The nested child's result was steered to the parent. Wait for the
      // parent session file to be COMPLETE (carry the subagent_result steer for
      // nested-<id>): that steer only lands after the nested child has fully
      // exited, which is what makes its activity file phase "done". The parent
      // is the unique session file without a loadout sidecar (names embed a
      // per-run unique id, so no cross-test collision).
      const parentFile = await waitForTopLevelSessionFile(env.dir, `nested-${id}`, PI_TIMEOUT, true);

      // At end of test: every activity file under the PARENT's artifact dir is
      // phase "done". (The nested child's own child writes its activity file to
      // the nested child's artifact dir, not the parent's.)
      const parentSessionId = (parseSessionEntries(parentFile)[0] as any).id;
      const activityDir = join(dirname(parentFile), "artifacts", parentSessionId, "subagent-activity");
      const activityFiles = readdirSync(activityDir).filter((f) => f.endsWith(".json"));
      assert.ok(activityFiles.length >= 1, `parent artifact dir should have ≥1 activity file, found ${activityFiles.length}`);
      for (const f of activityFiles) {
        const a = JSON.parse(readFileSync(join(activityDir, f), "utf8"));
        assert.equal(a.phase, "done", `activity file ${f} should be phase "done", got ${a.phase}`);
      }
    });
  });
}
