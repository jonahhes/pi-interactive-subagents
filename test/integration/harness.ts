/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect whether tmux is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in tmux panes
 * - Poll for file creation and screen output
 * - Clean up panes and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import {
  muxKind,
  createSurface,
  createSurfaceSplit,
  createSurfaceTab,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  closeSurfaceContainer,
  labelSurface,
  shellEscape,
} from "../../pi-extension/subagents/surface.ts";

// Re-export surface primitives for tests (dispatch to the active backend).
export {
  createSurface,
  createSurfaceSplit,
  createSurfaceTab,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  closeSurfaceContainer,
  labelSurface,
  shellEscape,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "litellm/coding";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/**
 * Detect which multiplexer backends are available in the current environment.
 * Returns e.g. ["herdr"], ["tmux"], or [] when neither is running.
 */
export function getAvailableBackends(): string[] {
  const kind = muxKind();
  return kind ? [kind] : [];
}

function herdrCliJson(args: string[]): any {
  return JSON.parse(execFileSync("herdr", args, { encoding: "utf8" }));
}

/**
 * Focus a specific herdr pane. The CLI `pane focus` is direction-based only,
 * so a short-lived node child issues `pane.focus` (socket API) with the
 * pane id and exits once the server answers.
 */
function herdrFocusPane(paneId: string): void {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
  const script = `const net = require("node:net");
const s = net.connect(${JSON.stringify(socketPath)});
let settled = false;
const done = (code) => { if (!settled) { settled = true; process.exit(code); } };
s.on("connect", () => {
  s.write(JSON.stringify({ id: "harness-focus", method: "pane.focus", params: { pane_id: ${JSON.stringify(paneId)} } }) + "\\n");
});
let buf = "";
s.on("data", (d) => {
  buf += d.toString();
  const line = buf.split("\\n").filter(Boolean)[0];
  if (line) {
    try {
      const r = JSON.parse(line);
      if (r.error) { console.error(JSON.stringify(r.error)); process.exitCode = 1; }
    } catch {}
    done(process.exitCode ?? 0);
  }
});
s.on("error", (e) => { console.error(String(e)); done(1); });
setTimeout(() => done(0), 2000);
`;
  execFileSync("node", ["-e", script], { encoding: "utf8" });
}

export function focusSurface(surface: string): void {
  const kind = muxKind();
  if (kind === "herdr") {
    herdrFocusPane(surface);
    return;
  }
  execFileSync("tmux", ["select-pane", "-t", surface], { encoding: "utf8" });
}

export function getFocusedSurface(): string | null {
  try {
    const kind = muxKind();
    if (kind === "herdr") {
      const data = herdrCliJson(["pane", "list"]);
      const focused = (data?.result?.panes ?? []).find((p: any) => p.focused);
      return focused?.pane_id ?? null;
    }
    const panes = execFileSync("tmux", ["list-panes", "-F", "#{pane_id} #{pane_active}"], {
      encoding: "utf8",
    });
    const activeLine = panes.split("\n").find((line) => line.endsWith(" 1"));
    return activeLine?.split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

export async function waitForFocusedSurface(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface() === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused tmux pane ${surface}; ` +
      `current focus is ${getFocusedSurface() ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Surfaces created during the test (cleaned up automatically), with kind */
  surfaces: Array<{ surface: string; kind: "pane" | "tab" }>;
  /** Temp files to clean up */
  tempFiles: string[];
}
/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    // Allow overriding the subagent model for environments where the
    // frontmatter model is not available (e.g. local LLM test runs).
    const agentModelOverride = process.env.PI_TEST_AGENT_MODEL;
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        const dest = join(agentsDir, file);
        cpSync(join(TEST_AGENTS_SRC, file), dest);
        if (agentModelOverride) {
          const content = readFileSync(dest, "utf8");
          const rewritten = content.replace(/^model:.*$/m, `model: ${agentModelOverride}`);
          writeFileSync(dest, rewritten);
        }
      }
    }
  }

  return { dir, surfaces: [], tempFiles: [] };
}

/**
 * Clean up all resources created during the test. Pane surfaces are closed with
 * closeSurface (kill pane). Tab surfaces are closed with closeSurfaceContainer
 * so the whole window/tab (including any descendant panes the test split into
 * it) is torn down; otherwise a tab's panes would outlive the test. Closing a
 * pane that is already gone is a no-op.
 */
export function cleanupTestEnv(env: TestEnv): void {
  // Close tabs first (destroys their panes too), then loose panes, so a pane
  // that is a descendant of an already-closed tab is skipped gracefully.
  for (const { surface, kind } of [...env.surfaces].reverse()) {
    try {
      if (kind === "tab") closeSurfaceContainer(surface);
      else closeSurface(surface);
    } catch {}
  }
  env.surfaces = [];
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export async function createTrackedSurface(env: TestEnv, name: string): Promise<string> {
  const surface = await createSurface(name);
  env.surfaces.push({ surface, kind: "pane" });
  return surface;
}

/**
 * Copy the repo's REAL bundled agent (agents/<name>.md) into the test env's
 * project-local .pi/agents/. createTestEnv() only copies test/integration/
 * agents/, so a case that must exercise a BUNDLED agent (e.g. `scout`, with
 * its `model-fallback: inherit` frontmatter) needs this explicit copy — the
 * source is the checked-in agents/ dir, never a re-authored test copy, so the
 * test proves the real bundled definition spawns and completes.
 */
export function copyBundledAgent(env: TestEnv, name: string): void {
  const src = join(PROJECT_ROOT, "agents", `${name}.md`);
  if (!existsSync(src)) throw new Error(`bundled agent not found: ${src}`);
  const agentsDir = join(env.dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  cpSync(src, join(agentsDir, `${name}.md`));
}

export async function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  const surface = await createSurfaceSplit(name, direction, fromSurface);
  env.surfaces.push({ surface, kind: "pane" });
  return surface;
}

/**
 * Create a subagent tab (a fresh labelled window/tab) and track it for
 * cleanup. Its kind is recorded so cleanup closes the whole container.
 */
export async function createTrackedSurfaceTab(
  env: TestEnv,
  name: string,
  cwd?: string,
): Promise<string> {
  const surface = await createSurfaceTab(name, cwd);
  env.surfaces.push({ surface, kind: "tab" });
  return surface;
}

/**
 * Return the id of the tab (herdr `wN:tN`) or window (tmux `@N`) that contains
 * the given pane, so tests can assert two surfaces share a container.
 */
export function getSurfaceContainerId(surface: string): string | null {
  try {
    const kind = muxKind();
    if (kind === "herdr") {
      const data = herdrCliJson(["pane", "get", surface]);
      return data?.result?.pane?.tab_id ?? null;
    }
    // tmux: pane id -> window id
    const win = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    return win || null;
  } catch {
    return null;
  }
}

/**
 * Return the label of the container (tab/window) holding `surface`: the herdr
 * tab label or the tmux window name. Null when the surface is gone.
 */
export function getSurfaceContainerLabel(surface: string): string | null {
  try {
    const kind = muxKind();
    if (kind === "herdr") {
      const info = herdrCliJson(["pane", "get", surface]);
      const tabId = info?.result?.pane?.tab_id;
      if (!tabId) return null;
      const wsId = info?.result?.pane?.workspace_id;
      const tabs = wsId ? herdrCliJson(["tab", "list", "--workspace", wsId]).result.tabs ?? [] : [];
      return tabs.find((t: any) => t.tab_id === tabId)?.label ?? null;
    }
    const win = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{window_name}"], {
      encoding: "utf8",
    }).trim();
    return win || null;
  } catch {
    return null;
  }
}

/**
 * Return the label of a surface: the herdr pane label (`pane get` ->
 * `pane.label`) or the tmux pane title. Null when the surface or its
 * label is gone.
 */
export function getSurfaceLabel(surface: string): string | null {
  try {
    const kind = muxKind();
    if (kind === "herdr") {
      const info = herdrCliJson(["pane", "get", surface]);
      const label = info?.result?.pane?.label;
      return typeof label === "string" && label !== "" ? label : null;
    }
    const title = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_title}"], {
      encoding: "utf8",
    }).trim();
    return title || null;
  } catch {
    return null;
  }
}

/**
 * Return the labels of ALL surfaces the backend currently knows about:
 * herdr pane labels (`pane list` -> `pane.label`) or tmux window names
 * (tabs are windows). Used to assert a torn-down subagent surface is gone.
 */
export function listSurfaceLabels(): string[] {
  try {
    const kind = muxKind();
    if (kind === "herdr") {
      const data = herdrCliJson(["pane", "list"]);
      return (data?.result?.panes ?? [])
        .map((p: any) => p.label ?? p.name ?? null)
        .filter((l: string | null): l is string => typeof l === "string" && l !== "");
    }
    const out = execFileSync("tmux", ["list-windows", "-a", "-F", "#{window_name}"], {
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Poll until `label` no longer appears among the backend's surface labels
 * (the pane/window was torn down). Throws on timeout.
 */
export async function waitForSurfaceGone(label: string, timeout: number = PI_TIMEOUT): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!listSurfaceLabels().includes(label)) return;
    await sleep(500);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for surface "${label}" to be removed; ` +
      `current labels: ${listSurfaceLabels().join(", ")}`,
  );
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s.surface !== surface);
}

// ── Pi session management ──

/**
 * Find the parent pi's session file: the (unique) `.jsonl` under the pi
 * sessions root containing a `subagent_result` custom message addressed to
 * `childName`. The child name embeds a unique test id, so it cannot collide
 * with another test's sessions. We scan all session dirs (rather than
 * reconstructing pi's cwd→dirname encoding, which normalises trailing
 * slashes) and only consider files written in the last `windowMs`.
 */
export async function waitForParentSessionFile(childName: string, windowMs = 30 * 60_000, timeout = PI_TIMEOUT): Promise<string> {
  const root = join(homedir(), ".pi", "agent", "sessions");
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

/** Parse a pi session .jsonl file into its entry objects. */
export function parseSessionEntries(path: string): any[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: {
    model?: string;
    extraArgs?: string;
    /** Extra env vars to UNSET on the parent (additive to the always-stripped spawner-identity vars). */
    envScrub?: string[];
    /** Extra env vars to SET on the parent (applied after the scrub). */
    envSet?: Record<string, string>;
  },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // The parent pi here is always a TOP-LEVEL spawner (it calls `subagent` with
  // an explicit `agent:`). It must never inherit a restricted-subagent identity
  // from the launcher shell: if the test suite is run FROM within a subagent
  // (e.g. a worker that spawns this test run), the shell carries
  // PI_SUBAGENT_ALLOWED / PI_SUBAGENT_NAME / …, and the extension would treat
  // the parent as a restricted child — filtering its agent discovery (dropping
  // `worker` and the project-local test agents) and refusing every spawn.
  // herdr panes do not propagate the launcher env (they get the server's clean
  // env), but tmux sessions launched via `tmux new-session` DO — so strip the
  // spawner-identity vars explicitly for a deterministic top-level parent in
  // both backends.
  const stripIdentity = [
    "PI_SUBAGENT_ALLOWED",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_SURFACE",
    "PI_SUBAGENT_ACTIVITY_FILE",
  ]
    .map((v) => `-u ${v}`)
    .join(" ");

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const scrubParts = [stripIdentity];
  if (opts?.envScrub) {
    for (const v of opts.envScrub) scrubParts.push(`-u ${v}`);
  }
  const setParts: string[] = [];
  if (opts?.envSet) {
    for (const [k, v] of Object.entries(opts.envSet)) {
      setParts.push(`${k}=${shellEscape(v)}`);
    }
  }
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `env ${scrubParts.join(" ")}`,
    setParts.length > 0 ? `env ${setParts.join(" ")}` : "",
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
