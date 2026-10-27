/**
 * Surface facade — dispatches subagent surface operations to the active
 * surface backend: a terminal multiplexer (herdr or tmux) or the headless
 * `background` backend (detached pi child, output to a log file).
 *
 * Backend resolution (`activeBackend`, never null):
 *   1. `PI_SUBAGENT_BACKEND` env override (validated; wins over everything)
 *   2. config.json `spawn.backend` preference
 *   3. environment detection: herdr (HERDR_ENV=1, socket, CLI) → tmux
 *      (TMUX set, CLI)
 *   4. `background` — the floor. `auto` never errors; a bare environment
 *      resolves to headless execution.
 *
 * Surface-CREATING operations always use the active backend. Surface-SCOPED
 * operations route by id prefix: `bg:` ids are background surfaces, all
 * other ids belong to the active multiplexer backend (herdr/tmux ids are
 * opaque per-backend strings and are never re-derived from the id).
 *
 * index.ts only ever imports from this file. The per-backend
 * implementations live in herdr.ts, tmux.ts and background.ts and implement
 * the same small surface API: create a surface, type a command into it,
 * read its screen, close it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as tmux from "./tmux.ts";
import * as herdr from "./herdr.ts";
import { resolveSpawnBackend } from "./status.ts";
import {
  createBackgroundSurface,
  launchBackground,
  readBackground,
  interruptBackground,
  closeBackground,
  backgroundExitCode,
  backgroundLogPath,
  hasBackgroundSurface,
  setBackgroundLogPath,
  allBackgroundSurfaces,
} from "./background.ts";

export type MuxKind = "herdr" | "tmux" | "background";

// ── Backend interface ──

interface MuxBackend {
  kind: MuxKind;
  available(): boolean;
  /** Create a pane for a subagent off the parent pi's pane. */
  createSurface(name: string): Promise<string>;
  /** Create a dedicated tab/window for a top-level subagent, non-focused. */
  createSurfaceTab(name: string, cwd?: string): Promise<string>;
  /** Create a split in the given direction from an optional source pane. */
  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
  ): Promise<string>;
  /** Type a command into a pane and submit it. */
  sendCommand(surface: string, command: string): void;
  /** Type a long command via a script file; returns the script path. */
  sendLongCommand(
    surface: string,
    command: string,
    options?: { scriptPath?: string; scriptPreamble?: string },
  ): string;
  /** Deliver a message to the agent running in a pane (herdr: agent prompt with raw-pane fallback; tmux: raw send). */
  sendMessage(surface: string, message: string): void;
  /** Send a cancellation signal (Escape) to the pane without closing it. */
  interrupt(surface: string, signal?: AbortSignal): Promise<void>;
  /** Best-effort cosmetic label for the pane (herdr sidebar / tmux pane title). */
  labelSurface(surface: string, label: string): void;
  /** Read the pane screen (sync). */
  readScreen(surface: string, lines?: number): string;
  /** Read the pane screen (async). */
  readScreenAsync(surface: string, lines?: number): Promise<string>;
  /** Close the pane. */
  closeSurface(surface: string): Promise<void>;
  /** Close the entire tab/window containing a surface (all its panes). */
  closeSurfaceContainer(surface: string): Promise<void>;
}

export const tmuxBackend: MuxBackend = {
  kind: "tmux",
  available: tmux.isTmuxAvailable,
  createSurface: (name) => Promise.resolve(tmux.createSurface(name)),
  createSurfaceTab: (name, cwd) => tmux.createSurfaceTab(name, cwd),
  createSurfaceSplit: (name, direction, fromSurface) =>
    Promise.resolve(tmux.createSurfaceSplit(name, direction, fromSurface)),
  sendCommand: tmux.sendCommand,
  sendLongCommand: tmux.sendLongCommand,
  // tmux has no agent surface: raw send, flattened (a newline in a raw send
  // submits a partial turn in the child's TUI editor).
  sendMessage: (surface, message) => tmux.sendCommand(surface, herdr.flattenForRawPane(message)),
  interrupt: tmux.sendEscape,
  labelSurface: tmux.labelSurface,
  readScreen: tmux.readScreen,
  readScreenAsync: tmux.readScreenAsync,
  closeSurface: (surface) => {
    tmux.closeSurface(surface);
    return Promise.resolve();
  },
  closeSurfaceContainer: (surface) => {
    tmux.closeSurfaceContainer(surface);
    return Promise.resolve();
  },
};

export const herdrBackend: MuxBackend = {
  kind: "herdr",
  available: herdr.isHerdrAvailable,
  createSurface: (name) => herdr.createSurface(name),
  createSurfaceTab: (name, cwd) => herdr.createSurfaceTab(name, cwd),
  createSurfaceSplit: (name, direction, fromSurface) =>
    herdr.createSurfaceSplit(name, direction, fromSurface),
  sendCommand: herdr.sendCommand,
  sendLongCommand: herdr.sendLongCommand,
  sendMessage: herdr.sendMessage,
  interrupt: herdr.interruptHerdrPane,
  labelSurface: herdr.labelSurface,
  readScreen: herdr.readScreen,
  readScreenAsync: herdr.readScreenAsync,
  closeSurface: (surface) => {
    herdr.closeSurface(surface);
    return Promise.resolve();
  },
  closeSurfaceContainer: (surface) => {
    herdr.closeSurfaceContainer(surface);
    return Promise.resolve();
  },
};

/**
 * The headless backend. Always available — that is the point: it is the
 * floor that `auto` resolves to when no multiplexer is present. Surface
 * creation registers the surface in background.ts's module-level registry
 * with `logPath: undefined`; the log path (under
 * `artifacts/<sessionId>/subagent-logs/`) is only knowable at launch time
 * (it is derived from the caller-provided script path) and is registered
 * via setBackgroundLogPath from sendLongCommand.
 */
export const backgroundBackend: MuxBackend = {
  kind: "background",
  available: () => true,
  createSurface: (name) => {
    void name;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return Promise.resolve(createBackgroundSurface(id, undefined));
  },
  // Defense in depth: a background child has no pane to tab/split. index.ts
  // stops requesting tabs for background surfaces; if it ever asks anyway
  // this throws instead of silently creating the wrong thing.
  createSurfaceTab: () =>
    Promise.reject(new Error("background surfaces are headless: no tabs or splits")),
  createSurfaceSplit: () =>
    Promise.reject(new Error("background surfaces are headless: no tabs or splits")),
  // The launch *is* the command; it is delivered via sendLongCommand.
  sendCommand: () => {},
  sendLongCommand: (surface, command, options) => {
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

    // Derive the log path from the script location: scripts live under
    // artifacts/<sessionId>/subagent-scripts/<name>-<id>.sh, logs under
    // artifacts/<sessionId>/subagent-logs/<name>-<id>.log. A caller-supplied
    // scriptPath is always shaped like that; the temp fallback has no
    // artifact tree, so the log sits next to the script.
    const logsDir = options?.scriptPath
      ? join(dirname(options.scriptPath), "..", "subagent-logs")
      : dirname(scriptPath);
    setBackgroundLogPath(surface, join(logsDir, `${basename(scriptPath, ".sh")}.log`));
    launchBackground(surface, scriptPath);
    return scriptPath;
  },
  // Steering refusal (decision 2): a background child has no TUI to steer
  // into, so allowing ask_question would park it forever (no reply-
  // delivery path). index.ts checks the kind before calling this and shows
  // the clean refusal; this throw is the fallback for anything that does
  // not.
  sendMessage: () => {
    throw new Error(
      "background subagents cannot be steered (no TUI); wait for completion and resume, or interrupt",
    );
  },
  interrupt: async (surface) => {
    await interruptBackground(surface);
  },
  labelSurface: () => {},
  readScreen: (surface, lines = 50) => readBackground(surface, lines),
  readScreenAsync: (surface, lines = 50) => Promise.resolve(readBackground(surface, lines)),
  closeSurface: (surface) => closeBackground(surface),
  closeSurfaceContainer: (surface) => closeBackground(surface),
};

// ── Backend selection ──

export type SpawnBackendKind = "auto" | MuxKind;

let cachedBackend: MuxBackend | null = null;

/**
 * The config `spawn.backend` preference, set by index.ts at init from the
 * parsed config. A module-level setter (rather than surface.ts importing
 * index.ts or re-reading config.json) keeps the import graph acyclic:
 * index.ts → surface.ts → status.ts (status.ts imports none of these), and
 * surface.ts stays a pure facade. The PI_SUBAGENT_BACKEND env override does
 * NOT cross this boundary — activeBackend applies it at resolution time via
 * status.ts's pure resolveSpawnBackend, so it wins over this config value
 * (override-first ordering is what makes nested-child propagation correct:
 * a child inherits PI_SUBAGENT_BACKEND and must not re-detect a different
 * multiplexer from inherited HERDR- / TMUX-family markers).
 */
let configBackendPreference: SpawnBackendKind = "auto";

/**
 * Set the config `spawn.backend` preference (index.ts calls this at init;
 * tests call it to simulate config). Clears the resolved-backend cache so
 * the new preference takes effect on the next activeBackend() call.
 */
export function setConfigBackendPreference(value: SpawnBackendKind): void {
  cachedBackend = null;
  configBackendPreference = value;
}

export const __setConfigBackendPreferenceForTest__ = setConfigBackendPreference;

/**
 * Drop the resolved-backend cache. Env changes (PI_SUBAGENT_BACKEND,
 * HERDR/TMUX markers) made after the first resolution only take effect after
 * this (or __setBackendForTest__/the config-preference setter, which also
 * clear the cache). Used by tests that mutate env mid-suite.
 */
export function __resetActiveBackendCacheForTest__(): void {
  cachedBackend = null;
}

/**
 * Force a backend (used by tests). Pass null to clear the override and
 * return to preference/environment resolution.
 */
export function __setBackendForTest__(backend: MuxBackend | null): void {
  cachedBackend = backend;
}

/**
 * Pure backend resolver (unit-testable): maps a resolved backend preference
 * onto the environment.
 *
 * Order: the preference itself (already env-override > config, resolved by
 * status.ts resolveSpawnBackend) → else environment detection herdr → tmux
 * → `background` floor. An explicit herdr/tmux that is unavailable throws a
 * clear error naming the setup hint; `background` is always available.
 * `auto` never errors.
 */
export function resolveSurfaceBackend(
  preferred: SpawnBackendKind,
  env: NodeJS.ProcessEnv,
  availability: { herdr: boolean; tmux: boolean },
): MuxBackend {
  if (preferred === "herdr" || preferred === "tmux") {
    const available = preferred === "herdr" ? availability.herdr : availability.tmux;
    if (!available) {
      const hint =
        preferred === "herdr"
          ? "Start pi inside herdr (run `herdr`)."
          : "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
      throw new Error(
        `The ${preferred} subagent backend was requested but is not available in this environment. ${hint} (Use "auto" to fall back to headless background execution.)`,
      );
    }
    return preferred === "herdr" ? herdrBackend : tmuxBackend;
  }
  if (preferred === "background") return backgroundBackend;
  if (availability.herdr) return herdrBackend;
  if (availability.tmux) return tmuxBackend;
  return backgroundBackend;
}

/**
 * The active backend, never null. Resolution: PI_SUBAGENT_BACKEND env
 * override → config `spawn.backend` preference (status.ts
 * resolveSpawnBackend) → for `auto`, environment detection herdr → tmux →
 * background floor. herdr is checked first because a herdr pane can also
 * contain a tmux server; the multiplexer hosting the pi process is the one
 * whose panes we must manage. Cached after first resolution; __setBackendForTest__,
 * __setConfigBackendPreferenceForTest__ and __resetActiveBackendCacheForTest__
 * clear the cache. An invalid PI_SUBAGENT_BACKEND or an explicit-but-
 * unavailable backend throws here (at first use), not at process start.
 */
export function activeBackend(): MuxBackend {
  if (cachedBackend) return cachedBackend;
  const preferred = resolveSpawnBackend(process.env.PI_SUBAGENT_BACKEND, configBackendPreference);
  cachedBackend = resolveSurfaceBackend(
    preferred,
    process.env,
    { herdr: herdr.isHerdrAvailable(), tmux: tmux.isTmuxAvailable() },
  );
  return cachedBackend;
}

/**
 * @deprecated Use activeBackend(). Kept as a thin alias for existing import
 * sites (tests); it can no longer return null.
 */
export function detectMux(): MuxBackend | null {
  return activeBackend();
}

/** Kind of the active backend (never null). */
export function muxKind(): MuxKind {
  return activeBackend().kind;
}

/**
 * True when any supported surface backend is available. Always true now:
 * headless background execution is the floor, so subagents work without a
 * multiplexer. Kept so existing guard sites stay harmless.
 */
export function isMuxAvailable(): boolean {
  return true;
}

/**
 * Human-readable setup hint for a multiplexer backend. Only meaningful for
 * explicit-backend-unavailable errors now that `auto` always resolves.
 */
export function muxSetupHint(): string {
  const kind = muxKind();
  if (kind === "herdr") return "Start pi inside herdr (run `herdr`).";
  if (kind === "tmux") return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or inside herdr (`herdr`).";
}

/** The log path of a `bg:` surface (undefined for non-background ids). */
export function backgroundLogPathOf(surface: string): string | undefined {
  return surface.startsWith("bg:") ? backgroundLogPath(surface) : undefined;
}

/** Close every live background surface (session_shutdown hygiene). */
export async function closeAllBackgroundSurfaces(): Promise<void> {
  await Promise.allSettled(allBackgroundSurfaces().map((s) => closeBackground(s)));
}

// ── Dispatched surface API ──

export { shellEscape } from "./tmux.ts";

function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith("bg:");
}

function backendFor(surface: string): MuxBackend {
  return isBackgroundSurface(surface) ? backgroundBackend : activeBackend();
}

/**
 * The MuxKind a surface id belongs to: `bg:` ids are background surfaces;
 * everything else belongs to the active backend (herdr/tmux ids are opaque
 * per-backend strings — never re-derived from the id).
 */
export function kindOf(surface: string): MuxKind {
  return backendFor(surface).kind;
}

/**
 * Create a new surface for a subagent off the parent pi's surface.
 * Returns the new surface id (tmux `%12` / herdr `w7:p5` / `bg:<id>`).
 * Surface-CREATING operations always use the active backend.
 */
export function createSurface(name: string): Promise<string> {
  return activeBackend().createSurface(name);
}

/**
 * Create a dedicated tab/window for a top-level subagent, non-focused and
 * labelled with `name`. Returns the root surface id (the tab's initial pane).
 * Surface-CREATING operations always use the active backend.
 */
export function createSurfaceTab(name: string, cwd?: string): Promise<string> {
  return activeBackend().createSurfaceTab(name, cwd);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Surface-CREATING operations always use the active backend.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  return activeBackend().createSurfaceSplit(name, direction, fromSurface);
}

/** Send a command string to a pane and execute it. */
export function sendCommand(surface: string, command: string): void {
  backendFor(surface).sendCommand(surface, command);
}

/**
 * Send a long command to a surface by writing it to a script file first.
 * Returns the script path. For `bg:` surfaces the script is launched as a
 * detached child instead of being typed into a pane.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return backendFor(surface).sendLongCommand(surface, command, options);
}

/** Deliver a message to the agent running in a pane. */
export function sendMessage(surface: string, message: string): void {
  backendFor(surface).sendMessage(surface, message);
}

/**
 * Send a backend-specific cancellation signal (Escape; SIGINT for
 * background) to a surface without closing it. The caller closes the
 * surface afterwards to guarantee termination — Escape alone may only park
 * the child session (pi's abort path keeps it open for inspection).
 */
export async function interrupt(surface: string, signal?: AbortSignal): Promise<void> {
  await backendFor(surface).interrupt(surface, signal);
}

/** Best-effort cosmetic label for the pane (herdr sidebar / tmux pane title). */
export function labelSurface(surface: string, label: string): void {
  backendFor(surface).labelSurface(surface, label);
}

/** Read the screen contents of a surface (sync). */
export function readScreen(surface: string, lines = 50): string {
  return backendFor(surface).readScreen(surface, lines);
}

/** Read the screen contents of a surface (async). */
export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return backendFor(surface).readScreenAsync(surface, lines);
}

/**
 * Close a surface. Async: the background backend kills the child's process
 * group and awaits exit (bounded, 5s); multiplexer closes are immediate but
 * still return a promise for a uniform contract.
 */
export function closeSurface(surface: string): Promise<void> {
  return backendFor(surface).closeSurface(surface);
}

/**
 * Close the entire tab/window containing a surface (all its panes). Used only
 * by test teardown; production closes the root pane and lets the container
 * auto-close when its last pane dies. Async for the same reason as
 * closeSurface.
 */
export function closeSurfaceContainer(surface: string): Promise<void> {
  return backendFor(surface).closeSurfaceContainer(surface);
}

// ── Exit polling (backend-agnostic) ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /**
   * True when the surface was gone (pane closed) and the terminal sentinel
   * could never be observed. This is how the watcher learns that an
   * interrupted run was torn down: the pane is closed on interrupt, and a
   * child that died mid-bash never gets to print its `__SUBAGENT_DONE_` line.
   */
  paneGone?: boolean;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * True when a surface read/write error means the PANE specifically is gone
 * (herdr `pane_not_found`, tmux `can't find pane`). A gone pane is not a
 * teardown failure: the child is already dead, and the watcher confirms via
 * its own paneGone detection. Deliberately narrow — a bare "not found"
 * (workspace/socket/server errors) is NOT a gone pane, and the dead-pane
 * classification in pollForExit must never key on anything else.
 */
export function isSurfaceGoneError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return /pane[_ -]?not[_ -]?found|can'?t find pane/i.test(message);
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  let readFailures = 0;
  let firstReadError: string | null = null;
  // Separate counter for the background disappearance check: the bg "screen"
  // (log tail) read ALWAYS succeeds, which would reset readFailures every
  // tick and prevent strikes from accumulating.
  let bgGoneStrikes = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      readFailures = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch (error: any) {
      // Surface may have been destroyed — check if .exit file appeared in the meantime.
      let sidecar: PollResult | null = null;
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            sidecar = interpretExitSidecar(data);
          }
        } catch {}
      }
      if (sidecar) return sidecar;

      // No sidecar. The pane itself may be gone (killed, or closed after an
      // interrupt): a dead surface can never produce the terminal sentinel, so
      // without this the loop would run forever. ONLY errors that say the pane
      // specifically is missing count (isSurfaceGoneError — herdr
      // "pane_not_found", tmux "can't find pane"); any other read failure
      // (socket hiccup, busy pane, server error) is transient and the loop
      // keeps polling exactly as before, so a live child is never killed on a
      // false positive. Two consecutive gone probes (one tick apart) are
      // required before declaring the surface gone.
      if (isSurfaceGoneError(error)) {
        readFailures++;
        if (firstReadError === null) firstReadError = error?.message ?? String(error);
        if (readFailures >= 2) {
          return {
            reason: "error",
            exitCode: 1,
            errorMessage: `Subagent surface ${surface} is no longer available (${readFailures} consecutive gone-pane probes: ${firstReadError})`,
            paneGone: true,
          };
        }
      } else {
        // Transient read error: reset the counter and keep polling.
        readFailures = 0;
      }
    }

    // Background liveness: for `bg:` surfaces the "screen" is the log tail,
    // which NEVER throws — a dead child leaves no read failure behind. The
    // loop must therefore check the child's liveness explicitly.
    //
    // (a) The child exited WITHOUT printing the terminal sentinel (killed,
    //     crashed, or interrupted mid-turn): fail-closed — report an error
    //     outcome and retain the record in the background registry
    //     (ownership stays held; the watcher's close path retries/retains).
    //     `paneGone: true` makes the watcher classify an interrupted child
    //     (userInterrupted set before the exit was read) as an interruption,
    //     exactly like the multiplexer gone-pane path above.
    // (b) The registry record itself disappeared: three consecutive strikes
    //     before declaring the surface gone (transient safety, mirrors the
    //     two-strike gone-pane rule for multiplexer panes).
    if (surface.startsWith("bg:")) {
      const exitCode = backgroundExitCode(surface);
      if (exitCode !== null && exitCode !== undefined) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: `Background subagent exited with code ${exitCode} without completion sentinel`,
          paneGone: true,
        };
      }
      if (!hasBackgroundSurface(surface)) {
        bgGoneStrikes++;
        if (bgGoneStrikes >= 3) {
          return {
            reason: "error",
            exitCode: 1,
            errorMessage: "Background subagent surface disappeared before completion.",
            paneGone: true,
          };
        }
      } else {
        bgGoneStrikes = 0;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
