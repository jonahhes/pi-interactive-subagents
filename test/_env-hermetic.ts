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
