/**
 * Herdr backend for the subagent surface layer.
 *
 * Implements the same surface API as tmux.ts (create/split a pane, type a
 * command into it, read its screen, close it) on top of the `herdr` CLI and
 * the herdr socket API (newline-delimited JSON over HERDR_SOCKET_PATH).
 *
 * Panes are identified by herdr pane ids (e.g. `w7:p1`). Splits target the
 * parent pi's pane (`HERDR_PANE_ID`) so they follow the agent rather than
 * the user's focus. `pane split` is called with `--no-focus` so the parent
 * keeps keyboard focus.
 *
 * Rebalancing uses the socket API's `layout.set_split_ratio`, which adjusts
 * split ratios in place — the same tab, panes, processes, and focus are
 * preserved. (The alternative, `layout.apply`, rebuilds the tab: new tab and
 * pane ids, so it is never used for rebalancing.)
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Socket } from "node:net";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }
  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }
  commandAvailability.set(command, available);
  return available;
}

/** Socket path for the herdr server API, or null when not configured/available. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.HERDR_SOCKET_PATH?.trim();
  if (!path) return null;
  try {
    if (!existsSync(path)) return null;
  } catch {
    return null;
  }
  return path;
}

/**
 * Path to the herdr CLI. Herdr exports HERDR_BIN_PATH into every pane it
 * manages, so prefer that over a bare PATH lookup; PATH is the fallback.
 */
export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * True when running inside herdr: HERDR_ENV=1, the socket file exists, and
 * the `herdr` CLI is resolvable (HERDR_BIN_PATH or PATH).
 */
export function isHerdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HERDR_ENV !== "1") return false;
  if (!herdrSocketPath(env)) return false;
  return !!env.HERDR_BIN_PATH || hasCommand("herdr");
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error("herdr is required for subagents. Start pi inside herdr (run `herdr`).");
  }
}

/** Test hook: reset the command cache. */
export function __resetHerdrCachesForTest__(): void {
  commandAvailability.clear();
}

// ── Shell helpers (same semantics as tmux.ts) ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── CLI + socket RPC ──

function herdrCli(args: string[]): string {
  try {
    // Explicit stdio is load-bearing, not just hygiene: Node's execFileSync
    // (no stdio option) re-forwards the CAPTURED child stderr to the parent's
    // stderr in addition to exposing it on the error. The parent's stderr is
    // the herdr pane's TTY, so on a CLI failure (e.g. `pane_not_found` when a
    // pane was just closed) herdr's error JSON would flash onto the user's
    // screen even though the throw below is caught and classified. Piping
    // stdout/stderr keeps them captured (error.stderr still feeds the
    // isSurfaceGoneError classification) without touching the parent TTY.
    return execFileSync(herdrBin(), args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: any) {
    const stderr =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim()
        : error?.message ?? String(error);
    throw new Error(`herdr ${args.slice(0, 3).join(" ")} … failed: ${stderr}`);
  }
}

/** Test hook: lets tests drive the real CLI wrapper (e.g. against a fake herdr
 *  binary) to assert on error capture and the parent-stderr isolation. */
export const __herdrCliForTest__ = herdrCli;

function parseCliJson<T>(args: string[]): T {
  const out = herdrCli(args);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`Unexpected herdr ${args.join(" ")} output: ${out.slice(0, 200)}`);
  }
}

/**
 * One request/response round trip against the herdr socket API.
 * Wire format: a single JSON request line `{"id","method","params"}`
 * answered by a single JSON result line.
 */
export function herdrRpc(
  method: string,
  params: Record<string, unknown>,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<any> {
  const socketPath = options.socketPath ?? herdrSocketPath();
  if (!socketPath) {
    return Promise.reject(new Error(`herdr socket API unavailable (HERDR_SOCKET_PATH not set) while calling ${method}`));
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise<any>((resolve, reject) => {
    const socket = new Socket();
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`herdr socket timeout after ${timeoutMs}ms calling ${method}`)));
    }, timeoutMs);
    socket.once("error", (err) => {
      finish(() => reject(err));
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const line = buf.split("\n").find((l) => l.trim() !== "");
      if (!line) return; // wait for the full line (responses may split across packets)
      finish(() => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            reject(new Error(`herdr ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    socket.connect(socketPath, () => {
      socket.write(JSON.stringify({ id: `subagent-${Date.now()}`, method, params }) + "\n");
    });
  });
}

// ── Pane geometry ──

interface HerdrPaneRect {
  pane_id: string;
  rect: { x: number; y: number; width: number; height: number };
  focused?: boolean;
}
interface HerdrPaneLayout {
  tab_id: string;
  panes: HerdrPaneRect[];
}

function paneLayout(paneId?: string): HerdrPaneLayout {
  const args = ["pane", "layout"];
  if (paneId) args.push("--pane", paneId);
  const data = parseCliJson<any>(args);
  const layout = data?.result?.layout;
  if (!layout?.panes) throw new Error(`Unexpected herdr pane layout output for ${paneId ?? "tab"}`);
  return layout as HerdrPaneLayout;
}

/**
 * True when the tab's panes are visibly even (all widths and heights differ
 * by at most one cell). Used to skip no-op rebalances.
 */
export function isLayoutEven(panes: HerdrPaneRect[]): boolean {
  if (panes.length <= 1) return true;
  const ws = panes.map((p) => p.rect.width);
  const hs = panes.map((p) => p.rect.height);
  const widthsEven = Math.max(...ws) - Math.min(...ws) <= 1;
  const heightsEven = Math.max(...hs) - Math.min(...hs) <= 1;
  return widthsEven && heightsEven;
}

// ── Split direction ──

/**
 * `PI_SUBAGENT_SPLIT_DIRECTION` env override: "right", "down", or "auto"
 * (default, choose from geometry).
 */
export type SplitDirectionSetting = "right" | "down" | "auto";

export function splitDirectionSetting(): SplitDirectionSetting {
  const raw = process.env.PI_SUBAGENT_SPLIT_DIRECTION?.trim().toLowerCase();
  return raw === "right" || raw === "down" || raw === "auto" ? raw : "auto";
}

/**
 * Choose a split direction from the parent pane's geometry.
 *
 * Geometry rule ("auto" setting): terminal cells are ~2x taller than wide,
 * so a pane is "wide" when it has more than two columns per row. Wide panes
 * split right (side by side); tall/narrow panes split down. A missing or
 * zero-height rect falls back to "right". `PI_SUBAGENT_SPLIT_DIRECTION`
 * forces a fixed direction and skips the geometry check.
 */
export function chooseSplitDirection(
  rect: { width: number; height: number } | null | undefined,
  setting: SplitDirectionSetting = splitDirectionSetting(),
): "right" | "down" {
  if (setting !== "auto") return setting;
  if (!rect || rect.height === 0) return "right";
  // Terminal cells are ~2x taller than wide: a pane is "wide" when it
  // has more than two columns per row.
  return rect.width / rect.height >= 2 ? "right" : "down";
}

// ── Layout rebalancing (socket API) ──

/** Layout tree node from `layout.export`: a leaf pane or a binary split. */
export interface HerdrLayoutNode {
  type: "pane" | "split";
  pane_id?: string | null;
  direction?: "right" | "down";
  ratio?: number;
  first?: HerdrLayoutNode;
  second?: HerdrLayoutNode;
}

/** Count the pane leaves under a layout node. */
export function balanceLeafCount(node: HerdrLayoutNode | null | undefined): number {
  if (!node) return 0;
  if (node.type === "pane") return 1;
  return balanceLeafCount(node.first) + balanceLeafCount(node.second);
}

/**
 * Walk the exported layout tree and return the `layout.set_split_ratio`
 * calls that make every split proportion its subtrees by pane count (i.e. an
 * even "tiled" layout). `path` is the boolean walk from the tab root:
 * false = first/left, true = second/right (verified against herdr 0.9).
 *
 * The tree structure is unchanged — only ratios are set — so panes keep
 * their ids, contents, and focus.
 */
export function balanceTree(
  root: HerdrLayoutNode | null | undefined,
): { path: boolean[]; ratio: number }[] {
  const calls: { path: boolean[]; ratio: number }[] = [];
  function walk(node: HerdrLayoutNode | null | undefined, path: boolean[]): void {
    if (!node || node.type !== "split" || !node.first || !node.second) return;
    const firstCount = balanceLeafCount(node.first);
    const secondCount = balanceLeafCount(node.second);
    const total = firstCount + secondCount;
    if (total > 1) {
      calls.push({ path: [...path], ratio: firstCount / total });
    }
    walk(node.first, [...path, false]);
    walk(node.second, [...path, true]);
  }
  walk(root, []);
  return calls;
}

/**
 * Export the tab's split tree, compute even ratios, and apply them in place
 * via `layout.set_split_ratio` (one call per split, root first so deeper
 * splits resize within their already-corrected area).
 *
 * Exposed separately from the debounced rebalanceSurfaces() so integration
 * tests can await the result directly.
 */
export async function applyEvenLayout(hintPane?: string): Promise<void> {
  const paneId = hintPane ?? process.env.HERDR_PANE_ID;
  if (!paneId) return;

  const layout = await herdrRpc("layout.export", { tab_id: null, pane_id: paneId });
  const root = layout?.result?.layout?.root as HerdrLayoutNode | undefined;
  const tabId = layout?.result?.layout?.tab_id as string | undefined;
  if (!root || !tabId) return;

  const calls = balanceTree(root);
  if (calls.length === 0) return;

  for (const call of calls) {
    await herdrRpc("layout.set_split_ratio", {
      tab_id: tabId,
      path: call.path,
      ratio: call.ratio,
    });
  }
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance the caller's tab so repeated splits don't leave panes
 * lopsided. herdr halves the target pane on every split, so without this a
 * row of spawned subagents drifts to 43/21/21/85-style widths. Non-fatal:
 * a cosmetic resize must never break spawning or watching.
 */
export function rebalanceSurfaces(hintPane?: string): void {
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    void applyEvenLayout(hintPane).catch(() => {
      // Pane/tab may be gone; balancing is best-effort.
    });
  }, 120);
}

/** Test hook: clear the pending rebalance timer. */
export function __resetRebalanceTimerForTest__(): void {
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = null;
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a split off the parent pi's pane, so new
 * panes follow the agent rather than the user's focus. Direction is chosen
 * from the parent's aspect ratio (see chooseSplitDirection): wide panes
 * split right, tall panes split down.
 *
 * Returns the new pane id (e.g. `w7:p5`).
 */
export async function createSurface(name: string): Promise<string> {
  void name; // herdr panes can be renamed; the pi process inside shows its own title.
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) {
    throw new Error("HERDR_PANE_ID is not set — the parent pi process is not running in a herdr pane");
  }

  let direction: "right" | "down" = "right";
  try {
    const layout = paneLayout(parent);
    const parentPane = layout.panes.find((p) => p.pane_id === parent);
    direction = chooseSplitDirection(parentPane?.rect);
  } catch {
    // Keep the default if the parent pane no longer reports a layout.
  }

  return createSurfaceSplit(name, direction, parent);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `w7:p5`).
 */
export async function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  requireHerdr();

  // herdr only supports right/down splits; map the tmux directions onto them.
  const herdrDirection = direction === "down" || direction === "up" ? "down" : "right";

  const args = ["pane", "split", "--no-focus"];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }
  args.push("--direction", herdrDirection);

  const data = parseCliJson<any>(args);
  const paneId = data?.result?.pane?.pane_id as string | undefined;
  if (!paneId || !paneId.includes(":p")) {
    throw new Error(`Unexpected herdr split output: ${JSON.stringify(data?.result ?? data)}`);
  }

  labelSurface(paneId, name);
  rebalanceSurfaces(paneId);
  return paneId;
}

/** Label a pane in the Herdr sidebar. Cosmetic and best-effort. */
export function labelSurface(surface: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  try {
    herdrCli(["pane", "rename", surface, trimmed]);
  } catch {
    // A missing label must never break spawning.
  }
}

/**
 * Create a dedicated herdr tab for a top-level subagent, labelled with `name`
 * and starting a shell in `cwd`. Created with `--no-focus` so the caller keeps
 * keyboard focus. Returns the new tab's root pane id (e.g. `w7:p46`).
 *
 * `--workspace` is mandatory: without it herdr creates the tab in whichever
 * workspace is currently focused, which may not be the caller's. We resolve
 * the caller's workspace (and cwd) from its own pane via `pane get`. If the
 * workspace cannot be resolved (pane already closed / transient error), we
 * fall back to a plain pane split off the caller rather than guessing the
 * focused workspace — the pane inherits the caller's correct workspace and we
 * degrade to the default layout instead of misplacing the subagent.
 */
export async function createSurfaceTab(name: string, cwd?: string): Promise<string> {
  requireHerdr();

  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error("HERDR_PANE_ID is not set — the parent pi process is not running in a herdr pane");
  }

  let tabCwd = cwd ?? null;
  let workspaceId: string | undefined;
  try {
    const info = parseCliJson<any>(["pane", "get", paneId]);
    const pane = info?.result?.pane;
    if (pane?.workspace_id) workspaceId = pane.workspace_id;
    if (!tabCwd && typeof pane?.cwd === "string" && pane.cwd !== "") tabCwd = pane.cwd;
  } catch {
    // pane unreadable — workspaceId stays undefined, we fall back below.
  }

  if (!workspaceId) {
    return createSurface(name);
  }

  const args = ["tab", "create", "--label", name, "--no-focus", "--workspace", workspaceId];
  if (tabCwd) args.push("--cwd", tabCwd);

  const data = parseCliJson<any>(args);
  const newPaneId = data?.result?.root_pane?.pane_id as string | undefined;
  if (!newPaneId || !newPaneId.includes(":p")) {
    throw new Error(`Unexpected herdr tab create output: ${JSON.stringify(data?.result ?? data)}`);
  }

  labelSurface(newPaneId, name);
  return newPaneId;
}

/**
 * Close the entire tab that contains `surface` (all its panes). Resolves the
 * pane's tab via `pane get`, then `tab close`. Best-effort: a no-op if the pane
 * or tab is already gone.
 */
export function closeSurfaceContainer(surface: string): void {
  requireHerdr();
  let tabId: string | undefined;
  try {
    const info = parseCliJson<any>(["pane", "get", surface]);
    tabId = info?.result?.pane?.tab_id;
  } catch {
    return; // pane already gone
  }
  if (!tabId) return;
  try {
    herdrCli(["tab", "close", tabId]);
  } catch {
    // Tab may already be gone.
  }
}

/**
 * Send a command string to a pane and execute it. `pane run` writes the
 * text literally and submits it with Enter as one ordered write, so
 * special characters are never interpreted as keys.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdrCli(["pane", "run", surface, command]);
}

/**
 * Flatten a multi-line message for raw-pane delivery (tmux, or the herdr
 * fallback before the agent is recognised): each newline in a raw send
 * submits a partial turn in the child's TUI editor, so the message must
 * arrive as one line.
 */
export function flattenForRawPane(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * True when herdr reports that no agent is recognised in the pane yet
 * (e.g. during startup). Such errors fall back to a raw pane send.
 * Pure so tests can exercise the matcher directly.
 */
export function isAgentNotFound(error: unknown): boolean {
  return /agent_not_found/.test((error as any)?.message ?? "");
}

/**
 * Deliver a message to the agent running in a pane. Goes through the
 * agent surface (`herdr agent prompt`) so Herdr honours bracketed paste
 * and refuses with `agent_blocked` when the agent sits at an approval or
 * question dialog, instead of typing over it.
 *
 * Falls back to the raw pane (send-text + Enter) only when Herdr has not
 * recognised an agent in the pane yet (`agent_not_found`), e.g. during
 * startup. The raw path flattens the message to a single line because
 * each newline there submits a partial turn in the TUI editor.
 * Any other error (including `agent_blocked`) propagates.
 */
export function sendMessage(surface: string, message: string): void {
  requireHerdr();
  try {
    herdrCli(["agent", "prompt", surface, message]);
  } catch (error) {
    if (!isAgentNotFound(error)) throw error;
    herdrCli(["pane", "send-text", surface, flattenForRawPane(message)]);
    herdrCli(["pane", "send-keys", surface, "Enter"]);
  }
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding
 * the pane's column width. Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  requireHerdr();
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `herdr-cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 * Uses `recent-unwrapped` so soft-wrapped lines are joined — a sentinel like
 * `__SUBAGENT_DONE_0__` stays one contiguous line even on narrow panes.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  const out = herdrCli([
    "pane",
    "read",
    surface,
    "--lines",
    String(Math.max(1, lines)),
    "--source",
    "recent-unwrapped",
  ]);
  return out.trimEnd();
}

/**
 * Read the screen contents of a pane (async).
 */
export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  return execFileAsync(
    herdrBin(),
    ["pane", "read", surface, "--lines", String(Math.max(1, lines)), "--source", "recent-unwrapped"],
    { encoding: "utf8" },
  ).then((r) => r.stdout.trimEnd());
}

/**
 * Send the canonical Escape key to cancel the in-flight turn. The caller
 * closes the pane to guarantee termination — Escape alone may only park the
 * session (pi's abort path keeps it open for inspection). Async (not the sync
 * herdrCli helper) so the interrupt tool never blocks the event loop on a
 * stuck pane.
 */
export async function interruptHerdrPane(pane: string, signal?: AbortSignal): Promise<void> {
  requireHerdr();
  await execFileAsync(herdrBin(), ["pane", "send-keys", pane, "esc"], { encoding: "utf8", signal, timeout: 5_000 });
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  herdrCli(["pane", "close", surface]);
  rebalanceSurfaces();
}
