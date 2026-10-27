/**
 * Integration tests for the surface layer (herdr or tmux backend).
 *
 * These tests exercise real multiplexer operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside the multiplexer you want to test (herdr or tmux);
 * the active backend is auto-detected from the environment.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  createTrackedSurfaceTab,
  focusSurface,
  getFocusedSurface,
  getSurfaceContainerId,
  getSurfaceContainerLabel,
  getSurfaceLabel,
  labelSurface,
  waitForFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const FOCUS_TEST_SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500");

if (backends.length === 0) {
  console.log("⚠️  No multiplexer available — skipping surface integration tests");
  console.log("   Run inside tmux or herdr to enable these tests.");
}

for (const backend of backends) {
  describe(`tmux-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async () => {
      const anchor = await createTrackedSurfaceSplit(env, "focus-anchor", "right");
      await sleep(1000);

      focusSurface(anchor);
      await waitForFocusedSurface(anchor, 10_000);

      const childA = await createTrackedSurface(env, "focus-child-a");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const childB = await createTrackedSurface(env, "focus-child-b");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), anchor);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = await createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("labels a surface with its name (herdr pane label / tmux pane title)", async () => {
      const name = `label-${uniqueId()}`.slice(0, 40);
      const surface = await createTrackedSurface(env, name);
      await sleep(1000);

      // herdr labels at create time; tmux only via labelSurface (select-pane -T).
      // Calling it explicitly covers both backends.
      labelSurface(surface, name);
      assert.equal(getSurfaceLabel(surface), name, "surface must carry its label");

      closeSurface(surface);
      untrackSurface(env, surface);
      assert.equal(getSurfaceLabel(surface), null, "label must be gone after close");
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = await createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = await createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      // Write the long value to a file instead of echoing it: a 500-char line
      // wraps across many rows on a narrow split pane (and can scroll off the
      // top of the captured screen), so asserting on the screen is width-
      // dependent and flaky. The file is immune to terminal wrapping and proves
      // the whole command reached the shell intact — the point of this test.
      const outFile = `/tmp/pi-integ-long-${marker}.txt`;
      trackTempFile(env, outFile);
      const command = `printf '%s' "LONG_${marker}_${longValue}_END" > ${outFile}`;

      sendLongCommand(surface, command);

      const content = await waitForFile(outFile, PI_TIMEOUT, /LONG_/);
      assert.ok(
        content.includes(`LONG_${marker}_`),
        `Expected long command prefix. Got:\n${content.slice(0, 300)}...`,
      );
      assert.ok(
        content.includes(`${longValue}_END`),
        `Expected the full untruncated value (incl. _END). Got length ${content.length}.`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = await createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("creates a tab: labelled, no focus steal, nested split stays in-tab, and teardown removes the tab", async () => {
      const label = `tab-it-${uniqueId()}`.slice(0, 40);
      const tabRoot = await createTrackedSurfaceTab(env, label, env.dir);
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);

      // 1. The tab is labelled with the subagent name.
      assert.equal(getSurfaceContainerLabel(tabRoot), label, "tab must be labelled with the subagent name");

      // 2. Focus was not stolen: the focused pane must not be the new tab pane.
      //    (Asserted against the created pane rather than "a specific anchor", so it
      //    holds on a shared server where other sessions contend for global focus.)
      assert.notEqual(
        getFocusedSurface(),
        tabRoot,
        "creating a tab must not steal focus onto the new tab pane",
      );

      // 3. The tab's root pane is a working shell in the requested cwd.
      const marker = uniqueId();
      sendCommand(tabRoot, `echo "TAB_${marker}"; pwd`);
      const screen = await waitForScreen(tabRoot, new RegExp(`TAB_${marker}`), 20_000, 50);
      assert.ok(
        screen.includes(env.dir),
        `tab should start in the requested cwd (${env.dir}); got:\n` + screen.slice(-400),
      );

      // 4. A nested split from the tab root lands in the SAME tab/window
      //    (this is how a subagent's own children stay with their parent), and
      //    also does not steal focus.
      const child = await createTrackedSurfaceSplit(env, "tab-nested", "right", tabRoot);
      await sleep(1000);
      assert.equal(
        getSurfaceContainerId(child),
        getSurfaceContainerId(tabRoot),
        "nested subagent pane must live in the same tab/window as its parent",
      );
      assert.notEqual(getFocusedSurface(), child, "nested split must not steal focus");

      // 5. Closing the descendant pane and the tab root tears the whole tab
      //    down (closing a container's last pane auto-closes it in both
      //    backends). The root is closed as a plain pane, never a kill-window,
      //    so a tab holding live children is never destroyed out from under them.
      closeSurface(child);
      untrackSurface(env, child);
      closeSurface(tabRoot);
      untrackSurface(env, tabRoot);
      await sleep(1500);
      assert.equal(getSurfaceContainerLabel(tabRoot), null, "tab should be gone after its last pane closes");
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = await createTrackedSurface(env, "multi-1");
      const s2 = await createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = await createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-tmux-test-${marker}.txt`;

      // The full marker only appears in the file (never echoed to the pane), so
      // the on-screen confirmation is a short token that cannot wrap in a
      // narrow pane. This keeps the "verify via surface" check from flaking
      // when the window is crowded into small panes by earlier tests.
      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_OK"`);

      await waitForScreen(surface, /WRITTEN_OK/, 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
