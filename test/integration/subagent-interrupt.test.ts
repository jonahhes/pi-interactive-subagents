/**
 * Integration test for subagent_interrupt (S2): a parent spawns a child that
 * is genuinely mid-bash (`sleep 30`), interrupts it by name, and the parent
 * must receive exactly ONE subagent_result steer with details.interrupted ===
 * true while the child's pane/tab is gone.
 *
 * Runs against whichever backend is active (herdr or tmux), like the other
 * integration suites.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  waitForSurfaceGone,
  sleep,
  uniqueId,
  trackTempFile,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No multiplexer available — skipping subagent interrupt integration tests");
  console.log("   Run inside tmux or herdr to enable these tests.");
}

/** pi stores per-cwd session files under `~/.pi/agent/sessions/<encoded>/`. */
function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * Find the parent pi's session file: the (unique) `.jsonl` under the pi
 * sessions root containing a `subagent_result` custom message addressed to
 * `childName`. The child name embeds a unique test id, so it cannot collide
 * with another test's sessions. We scan all session dirs (rather than
 * reconstructing pi's cwd→dirname encoding, which normalises trailing
 * slashes) and only consider files written in the last `windowMs`.
 */
async function waitForParentSessionFile(childName: string, windowMs = 30 * 60_000, timeout = PI_TIMEOUT): Promise<string> {
  const root = sessionsRoot();
  const start = Date.now();
  for (;;) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {}
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
          if (Date.now() - statSync(p).mtimeMs > windowMs) continue;
        } catch {
          continue;
        }
        let content = "";
        try {
          content = readFileSync(p, "utf8");
        } catch {
          continue;
        }
        if (content.includes(`"customType":"subagent_result"`) && content.includes(childName)) return p;
      }
    }
    if (Date.now() - start > timeout) throw new Error(`Timeout (${timeout}ms) finding parent session file in ${root}`);
    await sleep(1000);
  }
}

function parseSessionEntries(path: string): any[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

for (const backend of backends) {
  describe(`subagent-interrupt [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("interrupts a mid-bash child: one interrupted steer, pane gone, fast return", async () => {
      const id = uniqueId();
      const childName = `Sleeper-${id}`;
      const startFile = `/tmp/pi-integ-interrupt-${id}.txt`;
      trackTempFile(env, startFile);

      const surface = await createTrackedSurface(env, `interrupt-${id}`);
      await sleep(1000);

      const task = [
        `You must do exactly these steps, in order:`,
        ``,
        `1. Call the subagent tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        `   agent: "test-echo"`,
        `   task: "Run this bash command exactly as given: echo 'SLEPT_START_${id}' > '${startFile}'; sleep 30"`,
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
        `6. When the interruption notice arrives, say INTERRUPT_TEST_DONE and stop.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The child's bash started (it is now genuinely mid-`sleep 30`).
      const content = await waitForFile(startFile, PI_TIMEOUT, /SLEPT_START_/);
      assert.ok(content.includes(`SLEPT_START_${id}`), `start marker should contain SLEPT_START_${id}`);

      // The child's pane/tab must be gone after the interrupt (the handler
      // closes it; the watcher then confirms and steers the notice).
      await waitForSurfaceGone(childName, PI_TIMEOUT);

      // The parent processed the notice and finished the task.
      await waitForScreen(surface, /INTERRUPT_TEST_DONE/i, PI_TIMEOUT);

      // ── Assert on the parent's session file ──
      const parentFile = await waitForParentSessionFile(childName);
      const entries = parseSessionEntries(parentFile);

      // Exactly ONE subagent_result steer for this child, and it is the
      // interruption notice (interrupted: true, actor + requestedAt).
      const results = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
      );
      assert.equal(results.length, 1, `expected exactly one subagent_result for ${childName}, got ${results.length}`);
      const details = results[0].details;
      assert.equal(details.interrupted, true, "details.interrupted must be true");
      assert.equal(details.interruption?.actor, "main_agent", "top-level caller must be attributed main_agent");
      assert.ok(typeof details.interruption?.requestedAt === "string" && !Number.isNaN(Date.parse(details.interruption.requestedAt)), "requestedAt must be an ISO timestamp");
      assert.equal(typeof details.exitCode, "number");
      assert.equal(typeof details.elapsed, "number");
      assert.ok(results[0].content.includes(`was interrupted by main_agent`), "notice text names the actor");

      // No completion notice for this child (dedupe: interrupted, not finished).
      assert.ok(!results.some((e) => /completed/i.test(e.content)), "no 'completed' notice may follow an interrupt");

      // The interrupt tool call returned in < 10s (call → matching toolResult).
      const call = entries.find(
        (e) => e.type === "message" && e.message?.role === "assistant" &&
          (e.message.content ?? []).some((c: any) => c.type === "toolCall" && c.name === "subagent_interrupt"),
      );
      assert.ok(call, "parent session must contain a subagent_interrupt tool call");
      const callId = (call.message.content as any[]).find((c) => c.type === "toolCall" && c.name === "subagent_interrupt")!.id;
      const resultEntry = entries.find(
        (e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId === callId,
      );
      assert.ok(resultEntry, "the subagent_interrupt call must have a tool result");
      const latencyMs = Date.parse(resultEntry.timestamp) - Date.parse(call.timestamp);
      assert.ok(latencyMs < 10_000, `interrupt tool must return within 10s, took ${latencyMs}ms`);
    });
  });
}
