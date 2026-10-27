import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SubagentWaitingReason } from "./activity.ts";

export const SNAPSHOT_STALLED_AFTER_MS = 60_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

// Resolve to the real (non-symlink) location so the upward `../..` lands in
// the real package root (where config.json lives) regardless of how the
// extension directory is linked/installed.
const PACKAGE_ROOT = join(realpathSync(dirname(fileURLToPath(import.meta.url))), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "running";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

/**
 * Where a top-level subagent opens: "panes" splits off the caller's pane
 * (the historical default), "tabs" gives it its own labelled tab. Nested
 * subagents always open as panes, inside the subagent's own tab/window.
 */
export type SpawnSurface = "panes" | "tabs";

/**
 * Which subagent surface BACKEND to use: the terminal multiplexer hosting
 * the parent pi process (herdr/tmux), or the headless `background` backend
 * (detached pi child, output to a log file, no pane). `auto` is
 * herdr → tmux → background: `auto` never fails, background is the floor.
 * This is orthogonal to `SpawnSurface` (panes|tabs), which only decides how
 * a multiplexer surface is arranged and is ignored for background.
 */
export type SpawnBackend = "auto" | "herdr" | "tmux" | "background";

export interface SpawnConfig {
  surface: SpawnSurface;
  backend?: SpawnBackend;
}

/**
 * An extension loaded into every subagent regardless of its `tools` frontmatter
 * (e.g. bash-guard, which hard-blocks catastrophic bash commands in headless
 * sessions). Entries may be extension directories (a directory with a
 * package.json `pi.extensions` manifest or an index.ts/index.js) or a single
 * extension file (.ts/.js), absolute or `~/`-prefixed. Relative paths are
 * rejected — config.json lives inside this package, so relative entries would
 * silently mean different things per install location.
 */
export interface AlwaysOnExtensionsConfig {
  paths: string[];
  errors: string[];
}

export interface SubagentConfig {
  status: StatusConfig;
  spawn: SpawnConfig;
  alwaysOnExtensions: AlwaysOnExtensionsConfig;
}

export type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: StatusActivityPhase;
      active?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      waitingReason?: SubagentWaitingReason;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeNow: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingReason: SubagentWaitingReason | null;
  phase: StatusActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingReason: SubagentWaitingReason | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

/**
 * Parse the optional `spawn` section. An absent section (older config files)
 * defaults to "panes" so existing configs keep today's behaviour.
 */
export function parseSpawnConfig(rawConfig: unknown, source = "config.json"): SpawnConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.spawn == null) return { surface: "panes" };
  const spawn = requireObject(config.spawn, source, "spawn");
  rejectUnsupportedKeys(spawn, ["surface", "backend"], source, "spawn");
  if (spawn.surface !== "panes" && spawn.surface !== "tabs") {
    invalidConfig(source, `spawn.surface must be "panes" or "tabs"`);
  }
  if (
    spawn.backend !== undefined &&
    spawn.backend !== "auto" &&
    spawn.backend !== "herdr" &&
    spawn.backend !== "tmux" &&
    spawn.backend !== "background"
  ) {
    invalidConfig(
      source,
      `spawn.backend must be "auto", "herdr", "tmux" or "background"`,
    );
  }
  const result: SpawnConfig = { surface: spawn.surface };
  if (spawn.backend !== undefined) result.backend = spawn.backend;
  return result;
}

/**
 * Whether an absolute extension path is loadable by pi's child process:
 * a file (pi loads it as the entry point) or a directory with a package.json
 * `pi.extensions` manifest or an index.ts/index.js. pi's loader resolves
 * directories through the package manifest, so a directory without either
 * would be silently dropped in the child - flag it here instead.
 */
function extensionLoadabilityError(value: string): string | null {
  let stats;
  try {
    stats = statSync(value);
  } catch {
    return `${value} does not exist (skipped in all subagents)`;
  }
  if (stats.isFile()) return null;
  if (!stats.isDirectory()) {
    return `${value} is not a file or directory (skipped in all subagents)`;
  }
  if (existsSync(join(value, "index.ts")) || existsSync(join(value, "index.js"))) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(value, "package.json"), "utf8"));
    if (Array.isArray(manifest?.pi?.extensions) && manifest.pi.extensions.length > 0) return null;
  } catch {
    // No readable manifest: fall through to the not-loadable error.
  }
  return `${value} is a directory without a package.json pi.extensions manifest or index.ts/index.js (not a loadable extension path)`;
}

/**
 * Parse the optional `alwaysOnExtensions` section. An absent section (older
 * config files) means "no always-on extensions" so existing configs keep
 * today's behaviour. The child process resolves the entries with its own
 * pi loader (pi supports both explicit files and extension directories), so
 * validation here is deliberately structural only: it rejects relative paths
 * (config.json is package-local, so they would be ambiguous) and unknown keys,
 * and warns (without failing the spawn) about entries that are missing or not
 * loadable on the parent's machine.
 */
export function parseAlwaysOnExtensionsConfig(
  rawConfig: unknown,
  source = "config.json",
): AlwaysOnExtensionsConfig {
  const config = requireObject(rawConfig, source, "root");
  if (config.alwaysOnExtensions == null) return { paths: [], errors: [] };
  const raw = requireObject(config.alwaysOnExtensions, source, "alwaysOnExtensions");
  rejectUnsupportedKeys(raw, ["paths"], source, "alwaysOnExtensions");
  if (raw.paths == null) return { paths: [], errors: [] };
  if (!Array.isArray(raw.paths)) {
    invalidConfig(source, "alwaysOnExtensions.paths must be an array");
  }
  const errors: string[] = [];
  const paths: string[] = [];
  raw.paths.forEach((entry, i) => {
    if (typeof entry !== "string" || !entry.trim()) {
      invalidConfig(
        source,
        `alwaysOnExtensions.paths[${i}] must be a non-empty string (an absolute or ~/ path)`,
      );
    }
    const value = entry.trim();
    if (value === "~") {
      errors.push(
        `alwaysOnExtensions.paths[${i}] is "~" (the home directory is not a loadable extension path)`,
      );
      return;
    }
    if (value.startsWith("-")) {
      invalidConfig(
        source,
        `alwaysOnExtensions.paths[${i}] is an exclusion marker (leading "-"): exclusions only apply per-agent via the always-on-extensions frontmatter, not in config.json`,
      );
    }
    if (value.startsWith("~/")) {
      const home = homedir();
      const expanded = home ? join(home, value.slice(2)) : null;
      const problem = expanded ? extensionLoadabilityError(expanded) : null;
      if (problem) {
        errors.push(`alwaysOnExtensions.paths[${i}] "${value}": ${problem}`);
      } else {
        // Keep the ~/ form unexpanded: the child may resolve ~ differently at
        // launch time (see resolveAlwaysOnExtensionPaths in index.ts).
        paths.push(value);
      }
      return;
    }
    if (!value.startsWith("/")) {
      invalidConfig(
        source,
        `alwaysOnExtensions.paths[${i}] "${entry}" must be an absolute or ~/ path (config.json is package-local, so relative paths are ambiguous)`,
      );
    }
    const problem = extensionLoadabilityError(value);
    if (problem) {
      errors.push(`alwaysOnExtensions.paths[${i}] "${value}": ${problem}`);
      return;
    }
    paths.push(value);
  });
  return { paths, errors };
}

/**
 * Resolve the effective spawn surface: the PI_SUBAGENT_SPAWN_SURFACE env
 * override (case-insensitive, trimmed) wins over the config value. An
 * unrecognised override value is a configuration error and throws.
 */
export function resolveSpawnSurface(
  envOverride: string | undefined,
  configSurface: SpawnSurface,
): SpawnSurface {
  const raw = envOverride?.trim().toLowerCase();
  if (!raw) return configSurface;
  if (raw === "panes" || raw === "tabs") return raw;
  throw new Error(
    `Invalid PI_SUBAGENT_SPAWN_SURFACE value "${raw}" (expected "panes" or "tabs").`,
  );
}

/**
 * Resolve the effective spawn backend preference: the PI_SUBAGENT_BACKEND
 * env override (case-insensitive, trimmed) wins over the config value. An
 * unrecognised override value is a configuration error and throws. This is
 * a PREFERENCE only ("auto" still resolves dynamically against the
 * environment); see resolveSurfaceBackend in surface.ts for the resolution
 * itself.
 */
export function resolveSpawnBackend(
  envOverride: string | undefined,
  configBackend: SpawnBackend,
): SpawnBackend {
  const raw = envOverride?.trim().toLowerCase();
  if (!raw) return configBackend;
  if (raw === "auto" || raw === "herdr" || raw === "tmux" || raw === "background") return raw;
  throw new Error(
    `Invalid PI_SUBAGENT_BACKEND="${raw}"; expected "auto", "herdr", "tmux" or "background".`,
  );
}

function readSubagentConfigFile(configPath: string, examplePath: string): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadSubagentConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = CONFIG_EXAMPLE_PATH,
): SubagentConfig {
  const { sourcePath, rawConfig } = readSubagentConfigFile(configPath, examplePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return {
    status: parseStatusConfig(parsed, sourcePath),
    spawn: parseSpawnConfig(parsed, sourcePath),
    alwaysOnExtensions: parseAlwaysOnExtensionsConfig(parsed, sourcePath),
  };
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    waitingReason: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === "claude" ? "unseen" : "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity = lastActivityAtMs != null && (
    updatedAt < lastActivityAtMs ||
    (updatedAt === lastActivityAtMs && lastActivitySequence != null && sequence < lastActivitySequence)
  );
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride = state.localOverrideAtMs != null && (
    updatedAt < state.localOverrideAtMs ||
    (updatedAt === state.localOverrideAtMs && state.localOverrideSequence != null && sequence <= state.localOverrideSequence)
  );
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? observation.activeSince ?? state.activeSinceMs ?? updatedAt
    : null;
  const waitingSinceMs = phase === "waiting"
    ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt
    : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? observation.activeScope ?? null : null,
    waitingSinceMs,
    waitingReason: observation.waitingReason ?? null,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

export function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
  if (state.source === "claude") return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    waitingReason: null,
    phase: "waiting",
    latestEvent: "interrupt_requested",
    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: "waiting",
  };
}

function classifyProblemState(state: SubagentStatusState, now: number): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) return { kind: "stalled", statusLabel: problemLabel };

  const lastHealthyKind = state.activeNow
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingReason: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      kind = "active";
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind = elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS ? "stalled" : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText = state.activeSinceMs == null
    ? null
    : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText = state.waitingSinceMs == null
    ? null
    : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText = state.snapshotProblemSinceMs == null
    ? null
    : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingReason: state.waitingReason,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`);
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel && snapshot.statusLabel !== "done"
      ? ` (${snapshot.statusLabel})`
      : snapshot.statusLabel === "done"
        ? " (done)"
        : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`);
  }

  return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`);
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
