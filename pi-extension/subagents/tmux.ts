/**
 * tmux backend for the subagent surface layer.
 *
 * Everything the extension does to a tmux pane goes through the small API in
 * this file: create/split a pane, type a command into it, read its screen,
 * close it. Keeping the tmux calls isolated here means index.ts stays
 * testable without a multiplexer running. The herdr equivalent lives in
 * herdr.ts; surface.ts dispatches to the right backend at runtime.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──
//
// Every tmux call below that blocks the event loop (execFileSync) sets an
// explicit stdio: ["ignore","pipe","pipe"]. Node's execFileSync, when given no
// stdio option, re-forwards the captured child stderr to the parent's stderr —
// which inside a multiplexer pane is the user's TTY — so a tmux CLI error
// (e.g. "can't find pane" right after a pane is closed) would flash onto the
// screen even though the error is caught and handled. Piping keeps stdout/
// stderr captured (readScreen's return value, error classification) while
// keeping the parent TTY clean. The async execFileAsync calls already pipe by
// default and need no change.

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Create a dedicated tmux window (tab) for a top-level subagent, labelled with
 * `name` and starting in `cwd`. The window is created detached (`-d`) so the
 * active window/pane keeps focus, and returns the window's initial pane id
 * (e.g. `%13`).
 *
 * `new-window -n <label>` sets the window name AND disables automatic-rename
 * for it, so the label survives the shell running inside.
 *
 * `-t` must be a session (or session:window-index), not a pane; we resolve the
 * caller's session name from its pane id (handles spaces in session names).
 */
export async function createSurfaceTab(name: string, cwd?: string): Promise<string> {
  requireTmux();

  const pane = process.env.TMUX_PANE;
  if (!pane) {
    throw new Error("TMUX_PANE is not set - the parent pi process is not running in a tmux pane");
  }

  const session = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!session) {
    throw new Error("Failed to resolve tmux session name for tab creation");
  }

  const args = ["new-window", "-d", "-n", name, "-t", session];
  if (cwd) args.push("-c", cwd);
  args.push("-P", "-F", "#{pane_id}");

  const paneId = execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!paneId.startsWith("%")) {
    throw new Error(`Unexpected tmux new-window output: ${paneId}`);
  }

  // No rebalance: the new window has a single pane, and the caller's window
  // is untouched (it keeps its own even layout).
  return paneId;
}

/**
 * Close the entire window that contains `surface` (all its panes). `kill-window`
 * accepts a pane as its target and resolves to that pane's window.
 */
export function closeSurfaceContainer(surface: string): void {
  requireTmux();
  try {
    execFileSync("tmux", ["kill-window", "-t", surface], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // Window/pane may already be gone.
  }
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Send Escape to cancel the in-flight turn in a pane. Async (not execSync) so
 * the interrupt tool never blocks the event loop on a stuck pane. The caller
 * closes the pane afterwards to guarantee termination — Escape alone may only
 * park the session (pi's abort path keeps it open for inspection).
 */
export async function sendEscape(surface: string, signal?: AbortSignal): Promise<void> {
  requireTmux();
  await execFileAsync("tmux", ["send-keys", "-t", surface, "Escape"], {
    encoding: "utf8",
    signal,
    timeout: 5_000,
  });
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  rebalanceSurfaces();
}

/**
 * Label a pane (tmux pane title, shown with pane borders). Cosmetic and
 * best-effort: a missing label must never break spawning.
 */
export function labelSurface(surface: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  try {
    execFileSync("tmux", ["select-pane", "-t", surface, "-T", trimmed], { stdio: "ignore" });
  } catch {
    // Title may be unsupported; ignore.
  }
}

// ── Exit polling ──
// Shared by both backends: lives in surface.ts so it has one definition.
// Re-exported here for backward compatibility (tests and older imports).
export { pollForExit, type PollResult, __pollForExitTest__ } from "./surface.ts";
