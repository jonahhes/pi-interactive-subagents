import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-env hermeticity: clear the subagent-identity env vars that a TOP-LEVEL
 * spawner session never has, so this suite runs identically whether it is
 * invoked from a normal terminal, CI, or from WITHIN a spawned subagent.
 *
 * This module is imported FIRST by test.ts (before ../pi-extension/subagents/
 * index.ts) because index.ts captures PI_SUBAGENT_ALLOWED into a module-level
 * const (SUBAGENT_ALLOWLIST) at load time. Clearing the vars after the import
 * would be too late. A top-level session has none of these set; tests that
 * need a specific value set it explicitly and restore it in teardown.
 */
const SUBAGENT_IDENTITY_VARS = [
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SURFACE",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_BACKEND",
] as const;

for (const name of SUBAGENT_IDENTITY_VARS) {
  delete process.env[name];
}

/**
 * Point pi's agent config directory at an empty temp dir.
 *
 * `index.ts` calls `loadSubagentConfigWithSource()` at import time, so without
 * this the suite would read the developer's real
 * `~/.pi/agent/pi-interactive-subagents.json`: a personal file with an unknown
 * key or invalid JSON would make the whole import throw (every test in the file
 * fails), and a merely different one would silently change the module-level
 * spawn settings behind the suite's back. An empty dir means "no user-level
 * config", which is the state the tests in test.ts assume.
 *
 * Tests that need a specific value (or the unset default `$HOME/.pi/agent`)
 * set/restore `PI_CODING_AGENT_DIR` locally with `restoreEnvVar` /
 * `withIsolatedAgentEnv` - do not weaken this shield.
 */
const hermeticAgentDirPrefix = join(tmpdir(), "pi-subagents-hermetic-agent-");
const hermeticAgentDir = mkdtempSync(hermeticAgentDirPrefix);
process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;

/**
 * Delete the temp dir created above - and ONLY that one.
 *
 * INVARIANTS, both load-bearing (the delete is recursive):
 * 1. Never derive the path from `process.env.PI_CODING_AGENT_DIR`. Tests
 *    deliberately point that variable at a real agent dir, so an env-driven
 *    delete would `rm -rf` the user's `auth.json`, `sessions/`, and extensions
 *    as soon as one test failed to restore the var - or called
 *    `process.exit()` inside that window.
 * 2. Both the path and the prefix are captured at creation, never re-derived at
 *    exit: a test that sets and fails to restore `TMPDIR` would otherwise make
 *    a re-derived prefix check false and leak this dir on every run - silently,
 *    which is exactly the kind of quiet failure this module exists to prevent.
 */
process.on("exit", () => {
  if (!hermeticAgentDir.startsWith(hermeticAgentDirPrefix)) return;
  try {
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover empty temp dir is harmless.
  }
});
