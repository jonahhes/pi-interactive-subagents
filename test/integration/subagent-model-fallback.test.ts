/**
 * Integration tests for the S3 one-shot model fallback.
 *
 * Three cases, both backends (herdr or tmux, auto-detected):
 *   (a) FALLBACK   — a child whose frontmatter model is deliberately bogus
 *                    (`litellm/does-not-exist-xyz`) with an explicit
 *                    `model-fallback: litellm/coding` must COMPLETE via the
 *                    fallback: the completion steer carries the attribution
 *                    (from→to) and the failed first run's session file is
 *                    still on disk (retained, untouched).
 *   (b) NO-FALLBACK— a healthy spawn (litellm/coding, no fallback field)
 *                    completes with NO fallback attribution.
 *   (c) INTERRUPT  — interrupting a fallback-configured child mid-run must
 *                    NOT fall back: one interruption notice, no second
 *                    session file, no completion after the notice.
 *   (d) HEALTHY-FB — a child whose model is HEALTHY (litellm/coding) and has
 *                    a model-fallback configured completes normally with NO
 *                    fallback attribution in the completion steer and only
 *                    ONE child session file (no fallback retry ever launches).
 *   (e) RETRY-INT  — a bogus-primary + explicit-fallback child whose ONE-SHOT
 *                    RETRY is the live run when the parent interrupts by name:
 *                    exactly ONE subagent_result steer (the interruption
 *                    notice, details.interrupted === true), no "failed …
 *                    provider/agent error" steer with a fallback line, and the
 *                    retry's second session file is on disk.
 *
 * All assertions read session .jsonl files / artifact files / marker files —
 * never the pane screen (context hygiene).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSubagentLoadout } from "../../pi-extension/subagents/session.ts";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  waitForParentSessionFile,
  parseSessionEntries,
  sleep,
  uniqueId,
  trackTempFile,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No multiplexer available — skipping subagent model-fallback integration tests");
  console.log("   Run inside tmux or herdr to enable these tests.");
}

/** Read the parent spawner's name registry for the session file `parentFile`. */
function parentNameRegistry(parentFile: string): Record<string, { sessionFile: string; sessionId: string | null }> {
  try {
    const header = JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]);
    if (header?.type !== "session" || typeof header.id !== "string") return {};
    const registryPath = join(
      parentFile.slice(0, parentFile.lastIndexOf("/")),
      "artifacts",
      header.id,
      "subagent-registry.json",
    );
    if (!existsSync(registryPath)) return {};
    return JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return {};
  }
}

for (const backend of backends) {
  describe(`subagent-model-fallback [${backend}]`, { timeout: PI_TIMEOUT * 6 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    // ── (a) FALLBACK: bogus primary model completes via the explicit fallback ──

    it("completes via the fallback model: attribution in the steer, failed run retained", async () => {
      const id = uniqueId();
      const childName = `Fallback-${id}`;
      const markerFile = `/tmp/pi-integ-fallback-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `fallback-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "${childName}"`,
        `  agent: "test-fallback"`,
        `  task: "Run this bash command: echo 'FALLBACK_OK_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say FALLBACK_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The task completes only if the fallback child wrote the marker
      // (the bogus primary model can never produce a turn).
      const content = await waitForFile(markerFile, PI_TIMEOUT * 4, /FALLBACK_OK_/);
      assert.ok(content.includes(`FALLBACK_OK_${id}`), `marker should contain FALLBACK_OK_${id}`);

      await waitForScreen(surface, /FALLBACK_TEST_DONE/i, PI_TIMEOUT * 2);

      // ── Assert on the parent's session file ──
      const parentFile = await waitForParentSessionFile(childName);
      const entries = parseSessionEntries(parentFile);
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      // Exactly ONE attributed completion steer for the name (the fallback
      // child's; the failed primary never reports its own result).
      const completions = results.filter((e) => /completed/i.test(e.content) && e.details?.modelFallback);
      assert.equal(completions.length, 1, `expected exactly one attributed completion, got ${completions.length}`);
      const details = completions[0].details;

      // Attribution: from = the bogus primary, to = the explicit fallback.
      assert.equal(details.modelFallback.from, "litellm/does-not-exist-xyz");
      assert.equal(details.modelFallback.to, "litellm/coding");
      assert.ok(typeof details.modelFallback.failedSessionFile === "string", "failedSessionFile recorded");
      assert.ok(details.sessionFile, "result sessionFile recorded");
      assert.notEqual(
        details.sessionFile,
        details.modelFallback.failedSessionFile,
        "the result comes from a DIFFERENT (retry) session",
      );
      // The footer line is in the steer text the orchestrator reads.
      assert.ok(
        completions[0].content.includes("model fallback: `litellm/does-not-exist-xyz` → `litellm/coding`"),
        "completion text carries the 'model fallback: X → Y' line",
      );
      assert.equal(details.exitCode, 0, "the fallback run completed successfully");

      // The FAILED first run's session file is still on disk, untouched.
      assert.ok(existsSync(details.modelFallback.failedSessionFile), "failed first-run session file retained");
      const failedHeader = parseSessionEntries(details.modelFallback.failedSessionFile)[0];
      assert.equal(failedHeader.type, "session", "failed run session header intact");
      // The retry session (the result) is a different, healthy file.
      assert.ok(existsSync(details.sessionFile), "retry session file exists");
    });

    // ── (b) NO-FALLBACK: a healthy spawn carries no fallback attribution ──

    it("healthy spawn (no fallback field) completes without any fallback attribution", async () => {
      const id = uniqueId();
      const childName = `NoFallback-${id}`;
      const markerFile = `/tmp/pi-integ-nofallback-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `nofallback-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "${childName}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'NOFB_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say NOFALLBACK_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT * 3, /NOFB_/);
      assert.ok(content.includes(`NOFB_${id}`), `marker should contain NOFB_${id}`);
      await waitForScreen(surface, /NOFALLBACK_TEST_DONE/i, PI_TIMEOUT * 2);

      const parentFile = await waitForParentSessionFile(childName);
      const entries = parseSessionEntries(parentFile);
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      assert.ok(results.length >= 1, `expected a subagent_result for ${childName}`);
      // No fallback attribution anywhere — neither in details nor in text.
      for (const r of results) {
        assert.equal(r.details?.modelFallback, undefined, "no modelFallback details on a healthy spawn");
        assert.ok(!r.content.includes("model fallback:"), "no 'model fallback' line in a healthy completion");
      }
      const completion = results.find((e) => /completed/i.test(e.content));
      assert.ok(completion, "a completion steer exists");
      assert.equal(completion.details.exitCode, 0);
    });

    // ── (c) INTERRUPT: cancelling a fallback-configured child must NOT fall back ──
    //
    // The child must be ALIVE when the interrupt lands, or the fallback (which
    // fires on the failed primary's exit) would win the race. A bogus-primary
    // model (403) dies in ~0.4s — non-retryable — before any interrupt can
    // reach it. So this case uses `test-interrupt-fb`: a WORKING primary model
    // WITH a configured fallback, running a long bash (`sleep 30`) so it is
    // deterministically mid-run when the parent interrupts it. If the
    // interrupt suppresses the fallback, exactly ONE child session exists and
    // the only steer is the interruption notice (no fallback child, no
    // completion).
    it("interrupting a fallback-configured child does NOT trigger the fallback", async () => {
      const id = uniqueId();
      const childName = `InterruptFB-${id}`;
      // The child writes this file the moment its bash command starts (it is
      // now genuinely mid-`sleep 30`), then stays alive until the interrupt.
      const startFile = `/tmp/pi-integ-interruptfb-${id}.txt`;
      trackTempFile(env, startFile);

      const surface = await createTrackedSurface(env, `interruptfb-${id}`);
      await sleep(1000);

      const task = [
        `You must do exactly these steps, in order:`,
        ``,
        `1. Call the subagent tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        `   agent: "test-interrupt-fb"`,
        `   task: "Run this bash command exactly as given: echo 'INTFB_START_${id}' > '${startFile}'; sleep 30"`,
        ``,
        `2. Call the bash tool with EXACTLY: for i in $(seq 90); do [ -f '${startFile}' ] && break; sleep 1; done`,
        `   (This waits until the subagent's bash command has started.)`,
        ``,
        `3. Call the bash tool with EXACTLY: sleep 8`,
        ``,
        `4. Call the subagent_interrupt tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        ``,
        `5. Then stop and wait. An interruption notice will arrive as your next message on its own.`,
        `   Do NOT poll, do NOT call subagents_list or subagent_message, do NOT check files.`,
        ``,
        `6. When the interruption notice arrives, say INTERRUPTFB_TEST_DONE and stop.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(startFile, PI_TIMEOUT, /INTFB_START_/);
      assert.ok(content.includes(`INTFB_START_${id}`), "the child's bash started (it is now genuinely mid-run)");
      await waitForScreen(surface, /INTERRUPTFB_TEST_DONE/i, PI_TIMEOUT * 2);

      // ── Assert on the parent's session file ──
      const parentFile = await waitForParentSessionFile(childName);
      const entries = parseSessionEntries(parentFile);
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      // Exactly ONE steer for the child: the interruption notice.
      assert.equal(results.length, 1, `expected exactly one subagent_result (the interruption), got ${results.length}`);
      assert.equal(results[0].details.interrupted, true, "the notice is the interruption notice");
      // NO fallback happened: no attribution, no completion, no modelFallback.
      assert.equal(results[0].details.modelFallback, undefined, "interrupted runs never fall back");
      assert.ok(!/completed/i.test(results[0].content), "no completion notice for an interrupted run");
      assert.ok(!results[0].content.includes("model fallback"), "no fallback line in the interruption notice");
      assert.ok(results[0].content.includes("was interrupted by"), "the notice is the concise interruption notice");

      // No fallback child session: the authoritative record is the parent's
      // name registry — a fallback retry would have re-registered childName
      // to the RETRY's session file (in-place overwrite of the entry the
      // failed/interrupted primary left behind). It must still point at the
      // interrupted run's own session file.
      const sessionFile = results[0].details.sessionFile;
      assert.ok(typeof sessionFile === "string" && existsSync(sessionFile), "the interrupted run's session file exists");
      const registry = parentNameRegistry(parentFile);
      assert.equal(registry[childName]?.sessionFile, sessionFile, "the registry still maps the name to the interrupted run's session (no fallback re-registration)");
    });

    // ── (d) HEALTHY-FB: a HEALTHY model + configured fallback never falls back ──
    //
    // The trigger (provider/agent error, non-zero exit, or no assistant text)
    // never fires for a healthy run, so the configured `model-fallback`
    // (litellm/coding → litellm/coding-reasoning) is dead config: the run
    // completes normally, with NO fallback attribution anywhere and exactly
    // ONE child session file (no fallback retry ever launches).
    it("healthy run with a configured fallback completes with NO fallback attribution", async () => {
      const id = uniqueId();
      const childName = `HealthyFB-${id}`;
      const markerFile = `/tmp/pi-integ-healthyfb-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = await createTrackedSurface(env, `healthyfb-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "${childName}"`,
        `  agent: "test-fallback-healthy"`,
        `  task: "Run this bash command: echo 'HEALTHYFB_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say HEALTHYFB_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT * 3, /HEALTHYFB_/);
      assert.ok(content.includes(`HEALTHYFB_${id}`), `marker should contain HEALTHYFB_${id}`);

      const parentFile = await waitForParentSessionFile(childName);
      // Assert the parent's final marker from its session jsonl, NOT the pane
      // screen: the pane's rendered view can lag (or stop following) while the
      // session file is always up to date. One observed flake: the parent had
      // written HEALTHYFB_TEST_DONE to its session 4s after the child completed,
      // yet the captured screen still showed the pre-completion frame.
      {
        const doneDeadline = Date.now() + PI_TIMEOUT * 2;
        let done = false;
        while (!done && Date.now() < doneDeadline) {
          done = parseSessionEntries(parentFile).some(
            (e) =>
              e.type === "message" &&
              e.message?.role === "assistant" &&
              (e.message?.content ?? []).some(
                (c: any) => c?.type === "text" && /HEALTHYFB_TEST_DONE/i.test(c.text ?? ""),
              ),
          );
          if (!done) await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(done, `parent session jsonl should contain the HEALTHYFB_TEST_DONE marker`);
      }
      const entries = parseSessionEntries(parentFile);
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      assert.ok(results.length >= 1, `expected a subagent_result for ${childName}`);
      const completion = results.find((e) => /completed/i.test(e.content));
      assert.ok(completion, "a completion steer exists");
      assert.equal(completion.details.exitCode, 0, "the healthy run completed successfully");
      // No fallback attribution anywhere — neither in details nor in text.
      // (A healthy run's trigger never fires, so the configured fallback is dead config.)
      for (const r of results) {
        assert.equal(r.details?.modelFallback, undefined, "no modelFallback details on a healthy run");
        assert.ok(!r.content.includes("model fallback"), "no 'model fallback' line on a healthy run");
      }
      // No fallback retry launched: the run's own loadout sidecar records its
      // frozen model (a fallback retry would have been a SECOND run with its
      // own loadout under the SAME name, and the registry would re-map the
      // name to that retry's session file). This run's loadout is the healthy
      // primary model and the registry still points at this run's session.
      const sessionFile = completion.details.sessionFile;
      assert.ok(typeof sessionFile === "string" && existsSync(sessionFile), "the run's session file exists");
      const loadout = readSubagentLoadout(sessionFile);
      assert.ok(loadout, "the run's loadout sidecar exists");
      assert.equal(loadout.model, "litellm/coding", "the run launched with the healthy primary model");
      const registry = parentNameRegistry(parentFile);
      assert.equal(registry[childName]?.sessionFile, sessionFile, "the registry maps the name to this single run's session (no retry re-registration)");
    });

    // ── (e) RETRY-INT: interrupting the ONE-SHOT RETRY (not the primary) ──
    //
    // A bogus-primary child (test-fallback) fails in ~1s (its model 403s
    // before ANY tool call, so it never runs the task) and its one-shot
    // fallback RETRY becomes the live run. The retry is the ONLY run that can
    // execute the task, so the task writes a marker file the moment its bash
    // starts: waiting for the marker is a deterministic "the RETRY is
    // running" signal (the primary can never produce it). The parent then
    // interrupts by name while the retry is mid-`sleep 30`. The retry's
    // result must produce exactly ONE subagent_result steer: the
    // interruption notice (details.interrupted === true) — NOT a "failed …
    // provider/agent error" completion with a fallback line (a user
    // cancellation during the retry must not be misreported as a provider
    // failure). The notice's sessionFile is the RETRY's, and its loadout's
    // frozen model is the FALLBACK model (proving the interrupted run was
    // the retry, not the bogus primary).
    it("interrupting the fallback RETRY (mid-run) yields exactly one interruption notice, no failure steer", async () => {
      const id = uniqueId();
      const childName = `RetryInt-${id}`;
      // Written by the retry's bash the moment the retry is running (the bogus
      // primary model dies before any tool call, so only the retry can write it).
      const retryMarker = `/tmp/pi-integ-retryint-${id}.txt`;
      trackTempFile(env, retryMarker);

      const surface = await createTrackedSurface(env, `retryint-${id}`);
      await sleep(1000);

      const task = [
        `You must do exactly these steps, in order:`,
        ``,
        `1. Call the subagent tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        `   agent: "test-fallback"`,
        `   task: "Run this bash command exactly as given: echo 'RETRYINT_${id}' > '${retryMarker}'; sleep 30"`,
        ``,
        `2. Call the bash tool with EXACTLY:`,
        `   for i in $(seq 90); do [ -f '${retryMarker}' ] && break; sleep 1; done`,
        `   (This waits until the marker file exists — i.e. the fallback RETRY child is genuinely running. Its bogus primary model dies in ~1s without running any tool, so the marker can only be written by the retry. Stop waiting after ~90s even if it did not.)`,
        ``,
        `3. Call the subagent_interrupt tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        ``,
        `4. Then stop and wait. An interruption notice will arrive as your next message on its own.`,
        `   Do NOT poll, do NOT call subagents_list or subagent_message, do NOT check files.`,
        ``,
        `5. When the interruption notice arrives, say RETRYINT_TEST_DONE and stop.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The marker proves the retry was genuinely running (only the retry can
      // execute the task; the bogus primary dies before any tool call).
      const marker = await waitForFile(retryMarker, PI_TIMEOUT, /RETRYINT_/);
      assert.ok(marker.includes(`RETRYINT_${id}`), "the retry's bash started (the retry is the live run)");
      await waitForScreen(surface, /RETRYINT_TEST_DONE/i, PI_TIMEOUT * 3);

      // ── Assert on the parent's session file ──
      const parentFile = await waitForParentSessionFile(childName);
      const entries = parseSessionEntries(parentFile);
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      // Exactly ONE steer for the child: the interruption notice.
      assert.equal(results.length, 1, `expected exactly one subagent_result (the interruption), got ${results.length}`);
      assert.equal(results[0].details.interrupted, true, "the notice is the interruption notice");
      assert.equal(results[0].details.modelFallback, undefined, "no fallback attribution on the notice");
      // NO "failed … provider/agent error" steer with a fallback line — the
      // user cancellation of the retry must not be misreported as a failure.
      assert.ok(!/failed/i.test(results[0].content), "no 'failed' wording in the notice");
      assert.ok(!results[0].content.includes("model fallback"), "no fallback line in the notice");
      assert.ok(results[0].content.includes("was interrupted by"), "the notice is the concise interruption notice");

      // The interrupted run was the RETRY: the notice's sessionFile is the
      // retry's session, and its loadout froze the FALLBACK model (the primary
      // run's loadout would carry the bogus model instead).
      const sessionFile = results[0].details.sessionFile;
      assert.ok(typeof sessionFile === "string" && existsSync(sessionFile), "the interrupted (retry) run's session file exists");
      assert.ok(parseSessionEntries(sessionFile).length >= 1, "the retry session file is a valid session");
      const loadout = readSubagentLoadout(sessionFile);
      assert.ok(loadout, "the interrupted run's loadout sidecar exists");
      assert.equal(loadout.model, "litellm/coding", "the interrupted run launched with the fallback model (it was the retry, not the bogus primary)");
      // The retry re-registered the name IN PLACE (its registerName overwrote
      // the failed primary's entry — no delete window) and the notice's
      // finalize returned before any later re-registration, so the registry
      // maps the name to the retry's session (not the failed primary's).
      const registry = parentNameRegistry(parentFile);
      assert.equal(registry[childName]?.sessionFile, sessionFile, "the registry maps the name to the interrupted (retry) session");
    });
  });
}
