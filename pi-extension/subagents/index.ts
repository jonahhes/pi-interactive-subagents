import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Container, Text, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  muxKind,
  kindOf,
  activeBackend,
  backgroundLogPathOf,
  createSurface,
  createSurfaceTab,
  sendMessage,
  sendLongCommand,
  interrupt,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  isSurfaceGoneError,
  setConfigBackendPreference,
  closeAllBackgroundSurfaces,
} from "./surface.ts";

import { claimLeftClick } from "./mouse-toggle.ts";
import {
  countSessionEntryLines,
  deleteName,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  loadoutSidecarPath,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  sessionHasAssistantText,
  summarizeSessionStats,
  writeSubagentLoadout,
  type NameRegistry,
  type NameRegistryEntry,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadSubagentConfig,
  parseAlwaysOnExtensionsConfig,
  resolveSpawnSurface,
  resolveSpawnBackend,
  type SpawnBackend,
  type SpawnSurface,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/**
 * Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845
 * Resolved to the real (non-symlink) location so that upward-relative paths
 * (e.g. the bundled `agents/` dir at `../../agents`) land in the real package
 * whether the extension is loaded via a symlink, a pi-package install, or a
 * physical copy.
 */
const SUBAGENTS_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Short descriptive label for the pane/tab and widget row. Name the task, not the agent type: " +
        "2-4 words, lowercase, kebab-case, under 24 characters (e.g. 'auth-token-refactor'). " +
        "Omit to auto-generate a unique name (suffixed on collision). An explicit name must not " +
        "collide with a subagent already running or finished in this session, or the spawn is refused - " +
        "if the subagent exists, use subagent_message({ name }) to continue it. " +
        "Has no effect on which agent runs - use `agent` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  /**
   * Raw `model-fallback` frontmatter value, unvalidated. `inherit` or a
   * concrete `provider/model[:thinking]`. Absent (undefined) = no one-shot
   * fallback configured (custom agents stay opt-in). Invalid values are
   * refused at launch (validateModelFallback); discovery and the agent list
   * stay healthy and warn once per session.
   */
  modelFallback?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  /**
   * Extensions loaded into this agent's child in addition to the
   * tool-backing extensions and the global `alwaysOnExtensions` config
   * (e.g. a guard for a specific role). Entries are absolute or `~/` paths;
   * a leading `-` marks an exclusion that REMOVES a matching global
   * `alwaysOnExtensions` entry from this agent's loadout (e.g. one role
   * cleared to run what the guard blocks).
   */
  alwaysOnExtensions?: string[];
  /**
   * Raw (lowercased/trimmed, unvalidated) `bash-guard-mode` frontmatter value.
   * Validated at launch via validateBashGuardMode; the valid values are
   * off|prompt|floor|read-only. When set, the value is snapshotted into the
   * loadout and emitted into the child as PI_BASH_GUARD_MODE, selecting
   * bash-guard's mode there. Absent (undefined) means no env is emitted and
   * bash-guard's own heuristic applies (subagent → full floor). Bad values do
   * NOT throw at parse time (discovery must not crash); they are refused at
   * launch and warned once per session during discovery.
   */
  bashGuardMode?: string;
  /**
   * The agent .md file this definition was parsed from (absolute path), set
   * by the file-reading call sites so launch-time errors can name the file
   * the bad value came from.
   */
  sourceFile?: string;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_interrupt",
  "subagent_message",
  "subagents_list",
] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * The herdr-managed pi integration extension (reports the pi lifecycle to
 * the herdr server). Only present in herdr installations where the pi
 * integration was installed (herdr writes and owns this file). Restricted
 * children launch with `--no-extensions`, which disables global discovery
 * and would drop this file - re-adding it explicitly is what makes
 * `herdr agent prompt` steering work for them.
 */
function getHerdrStateExtensionPath(): string | null {
  const p = join(getAgentConfigDir(), "extensions", "herdr-agent-state.ts");
  return existsSync(p) ? p : null;
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted).
 */
function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // pi builtin extensions are loaded via `-e builtin:<name>` (pi >=1.0.0;
  // the CLI resolves the spec, so there is no file path to check). Codemode
  // is bundled for every subagent whose allowlist lists it; tool_search is
  // grantable for custom agents but not bundled.
  if (tool === "codemode") return "builtin:codemode";
  if (tool === "tool_search") return "builtin:tool-search";
  // The four spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

/**
 * Parse the `bash-guard-mode` frontmatter value: lowercase-trim and store RAW
 * (unvalidated). Deliberately lenient — this also runs from
 * discoverAgentDefinitions for subagents_list, where one bad file must not
 * crash the whole agent listing. Invalid values are refused at launch
 * (validateBashGuardMode) and surfaced once per session by discovery. Absent
 * or empty → undefined (no mode; bash-guard's own heuristic applies).
 */
function parseBashGuardMode(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  return v ? v : undefined;
}

function parseAgentDefinition(
  content: string,
  fallbackName: string,
  sourceFile?: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    modelFallback: getFrontmatterValue(frontmatter, "model-fallback"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    alwaysOnExtensions: parseCommaList(
      getFrontmatterValue(frontmatter, "always-on-extensions"),
    ),
    bashGuardMode: parseBashGuardMode(getFrontmatterValue(frontmatter, "bash-guard-mode")),
    sourceFile,
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const filePath = join(dir, file);
      const parsed = parseAgentDefinition(
        readFileSync(filePath, "utf8"),
        file.replace(/\.md$/, ""),
        filePath,
      );
      if (!parsed) continue;
      warnInvalidBashGuardModeOnce(parsed);
      warnInvalidModelFallbackOnce(parsed);
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

/**
 * Discovery-time visibility for a bad `bash-guard-mode`: one console.warn per
 * (agent, file, value) per session. Keeps subagents_list healthy (a bad value
 * must not crash the listing) without the mistake staying invisible; the
 * spawn itself is still refused — see validateBashGuardMode. Discovery runs
 * on every spawn (permitted-agent check) as well as subagents_list, hence the
 * once-per-session dedup.
 */
const warnedBashGuardModes = new Set<string>();
function warnInvalidBashGuardModeOnce(agent: AgentDefinition): void {
  const mode = agent.bashGuardMode;
  if (!mode || (BASH_GUARD_MODES as readonly string[]).includes(mode)) return;
  const key = `${agent.name}|${agent.sourceFile ?? "?"}|${mode}`;
  if (warnedBashGuardModes.has(key)) return;
  warnedBashGuardModes.add(key);
  console.warn(
    `[subagents] agent '${agent.name}' has invalid bash-guard-mode '${mode}' ` +
      `(expected off, prompt, floor, or read-only) in ${agent.sourceFile ?? "(unknown source)"}; ` +
      `spawning it will be refused until the value is fixed`,
  );
}

/**
 * S7 Phase 2: `safe_bash` has been REMOVED (it was a hand-rolled scanner with
 * proven bypasses; `bash` + a per-agent `bash-guard-mode` is the replacement).
 * The hook is kept because stale agent files on other machines may still list
 * `safe_bash` - the name is now a no-op tool, and this warning is the only
 * signal that such a file should be migrated. Warns once per session (module
 * lifetime), same pattern as warnInvalidBashGuardModeOnce.
 */
let warnedSafeBashDeprecated = false;
function warnSafeBashDeprecatedOnce(): void {
  if (warnedSafeBashDeprecated) return;
  warnedSafeBashDeprecated = true;
  console.warn("safe_bash was removed; use bash + bash-guard-mode (see README)");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName, p);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * D3.1: the resolved spawn backend of THIS process (never "auto" — the value
 * is what this process actually resolved to: PI_SUBAGENT_BACKEND env override
 * → config `spawn.backend` → environment detection → background floor). It
 * is propagated to every child via PI_SUBAGENT_BACKEND so a nested child
 * consults the override BEFORE environment detection and never re-detects a
 * different multiplexer from inherited HERDR-/TMUX-family markers (a
 * background child spawned by a herdr parent inherits HERDR_ENV and would
 * otherwise spawn its own children as herdr panes off the grandparent's
 * pane). Same value the child's surface was created with — the propagation
 * and the surface creation cannot drift.
 */
export function resolvedSpawnBackend(): string {
  return activeBackend().kind;
}

/**
 * Build the env parts for a subagent LAUNCH (spawn). Pure over its inputs —
 * no `process.env` reads — so the mandatory PI_SUBAGENT_BACKEND
 * nested-propagation (D3/D3.1) can be unit-tested in isolation. The caller
 * passes the RESOLVED backend (`resolvedSpawnBackend()`), never `"auto"`.
 * Preserves the historical env-part order exactly.
 */
export function buildSubagentLaunchEnvParts(params: {
  resolvedAgentDir: string | null;
  name: string;
  agent?: string;
  grantSpawning: boolean;
  spawnable?: string[];
  autoExit?: boolean;
  sessionFile: string;
  id: string;
  activityFile: string;
  surface: string;
  backend: string;
  bashGuardMode: string | null;
}): string[] {
  const envParts: string[] = [];
  if (params.resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(params.resolvedAgentDir)}`);
  }
  if (params.grantSpawning && params.spawnable) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(params.spawnable.join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (params.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(params.id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(params.activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(params.surface)}`);
  // D3/D3.1 (mandatory): pin the child's spawn backend to what THIS process
  // resolved (never "auto"). The child consults the override BEFORE
  // environment detection, so an inherited HERDR-/TMUX-family marker can't
  // misdirect its own nested spawns. See resolvedSpawnBackend().
  envParts.push(`PI_SUBAGENT_BACKEND=${shellEscape(params.backend)}`);
  // S2: emit the guard mode on spawn (absent agent field → no var, so the
  // guard's own heuristic applies in the child).
  const guardEnv = bashGuardModeEnvPart(params.bashGuardMode);
  if (guardEnv) envParts.push(guardEnv);
  return envParts;
}

/**
 * Build the env parts for a subagent RESUME. Pure over its inputs (no
 * `process.env` reads) so it shares the D3/D3.1 propagation guarantee with the
 * launch builder. The caller passes the backend re-resolved AT RESUME TIME
 * (`resolvedSpawnBackend()`), so a resumed background child stays background.
 * Preserves the historical env-part order exactly.
 */
export function buildSubagentResumeEnvParts(params: {
  agentDir: string | null;
  name: string;
  sessionPath: string;
  id: string;
  activityFile: string;
  agent?: string | null;
  spawnable?: string[] | null;
  autoExit: boolean;
  backend: string;
  bashGuardMode: string | null;
}): string[] {
  const envParts: string[] = [];
  if (params.agentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(params.agentDir)}`);
  }
  if (params.spawnable && params.spawnable.length > 0) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(params.spawnable.join(","))}`);
  }
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(params.id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(params.activityFile)}`);
  if (params.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  // D3/D3.1 (mandatory): a resumed background child must STAY background (and
  // a resumed child never re-detects a different multiplexer from inherited
  // markers). Resolved at resume time, like its new surface.
  envParts.push(`PI_SUBAGENT_BACKEND=${shellEscape(params.backend)}`);
  // S2: replay the guard mode from the snapshot (same rule as launch).
  const guardEnv = bashGuardModeEnvPart(params.bashGuardMode);
  if (guardEnv) envParts.push(guardEnv);
  return envParts;
}

/**
 * D5 / plan risk-1: the first background spawn in this session names its log
 * file in a one-line console.info so a headless spawn is discoverable.
 */
let backgroundLogAnnounced = false;
function noteBackgroundSpawn(name: string, logPath: string): void {
  if (backgroundLogAnnounced) return;
  backgroundLogAnnounced = true;
  console.info(`subagents: background subagent "${name}" runs headless — Log: ${logPath}`);
}

/** Test seam: reset the once-per-session background log announcement. */
function __resetBackgroundLogAnnouncementForTest__(): void {
  backgroundLogAnnounced = false;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  const kind = muxKind();
  const noun = kind === "herdr" ? "herdr" : kind === "tmux" ? "tmux" : "background";
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer (${noun}). ${muxSetupHint()}`,
      },
    ],
    details: { error: "multiplexer not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const SUBAGENT_CONFIG = loadSubagentConfig();
const statusConfig = SUBAGENT_CONFIG.status;
/** Configured spawn surface (config.json `spawn.surface`). */
const CONFIG_SPAWN_SURFACE: SpawnSurface = SUBAGENT_CONFIG.spawn.surface;
/** Configured spawn backend preference (config.json `spawn.backend`, default "auto"). */
const CONFIG_SPAWN_BACKEND: SpawnBackend = SUBAGENT_CONFIG.spawn.backend ?? "auto";
// Hand the config preference to the surface facade at init. surface.ts
// cannot import index.ts (index.ts is the only facade importer — that would
// be a cycle) and should not re-read config.json itself, so the preference
// crosses the boundary through this setter (documented in surface.ts).
setConfigBackendPreference(CONFIG_SPAWN_BACKEND);

/**
 * The effective spawn surface for this process. The PI_SUBAGENT_SPAWN_SURFACE
 * env override (case-insensitive) wins over the config, for testing or
 * per-session forcing without a config file. Read at call time so env changes
 * after module load are picked up.
 */
export function getSpawnSurface(): SpawnSurface {
  return resolveSpawnSurface(process.env.PI_SUBAGENT_SPAWN_SURFACE, CONFIG_SPAWN_SURFACE);
}

/**
 * The effective spawn backend preference for this process. The
 * PI_SUBAGENT_BACKEND env override (case-insensitive) wins over the config,
 * for testing or per-session forcing without a config file. Read at call
 * time so env changes after module load are picked up. This is a PREFERENCE
 * only — `auto` still resolves dynamically (herdr → tmux → background
 * floor); see surface.ts activeBackend/resolveSurfaceBackend.
 */
export function getSpawnBackend(): SpawnBackend {
  return resolveSpawnBackend(process.env.PI_SUBAGENT_BACKEND, CONFIG_SPAWN_BACKEND);
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    // A problem/state label keeps precedence (statusLabel first, then the
    // activity label — e.g. "interrupted" on a forced interrupt); otherwise
    // the waiting reason annotation names WHY the child is parked.
    const label = snapshot.statusLabel ?? snapshot.activityLabel;
    const detail = label
      ? ` · ${label}`
      : snapshot.waitingReason === "ask_question"
        ? " · question"
        : snapshot.waitingReason === "own_children"
          ? " · own children"
          : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage" | "fallback" | "launchFailed" | "backgroundLogPath"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
  // Plan risk-1: a background (headless) run has no pane to look at — name its
  // log file in every completion/failure presentation the child produced.
  const logLine = result.backgroundLogPath ? `\n\nLog: ${result.backgroundLogPath}` : "";
  // S3: attribute a one-shot fallback retry so the orchestrator sees which
  // model actually produced the result (the failed primary is retained in the
  // artifacts for diagnosis). For a launch failure (launchFailed) the
  // errorMessage already names the models and the launch failure, so the
  // fallback note would be redundant — skip it there.
  const fallbackNote = result.fallback && !result.launchFailed
    ? `model fallback: ${result.fallback.from ? `\`${result.fallback.from}\` → ` : ""}\`${result.fallback.to}\` ` +
      `(${result.fallback.reason}; the failed primary run stays in artifacts)` +
      (result.fallback.failedSessionFile ? ` [${result.fallback.failedSessionFile}]` : "") + "\n\n"
    : "";

  if (result.errorMessage) {
    if (result.launchFailed) {
      // S3: the fallback retry's LAUNCH failed — its surface was created but
      // the child never started, so nothing was ever retried. The errorMessage
      // is launch-failure-specific ("model fallback: `from` → `to` launch
      // failed: …") and the failed primary run stays in artifacts, resumable
      // by name — so no "auto-retry exhausted" framing here.
      return (
        `Sub-agent "${name}" failed to start its model-fallback retry ` +
        `after ${formatElapsed(result.elapsed)}.\n\n` +
        `Error: ${result.errorMessage}\n\n` +
        `No fallback child was launched; the failed primary run stays in ` +
        `artifacts.${sessionRef}${logLine}`
      );
    }
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      fallbackNote +
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}${logLine}`
    );
  }

  return (
    fallbackNote +
    (result.exitCode !== 0
      ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}${logLine}`
      : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}${logLine}`)
  );
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** True when the parent cancelled the run with `subagent_interrupt`. */
  interrupted?: boolean;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /**
   * The `bg:` surface's log file, when this run was a background (headless)
   * subagent. Rendered as a "Log: <path>" line in the completion/failure
   * presentation (plan risk-1) and on the interruption notice.
   */
  backgroundLogPath?: string;
  /** Whether this run produced any non-whitespace assistant text. */
  hasAssistantText?: boolean;
  /**
   * True when this is a fallback retry whose LAUNCH failed (its surface was
   * created but the child never started — no retry ever ran). The
   * presentation renders the errorMessage as-is (it is already
   * launch-failure-specific) instead of the "auto-retry exhausted" framing,
   * which would be a lie for a launch failure.
   */
  launchFailed?: boolean;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  /** Present when this is the result of a one-shot model fallback retry. */
  fallback?: FallbackAttribution;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /**
   * Set when the parent cancels the run with `subagent_interrupt`. The pane is
   * being torn down: hide the widget entry, ignore status transitions and
   * pending questions, and steer a concise interruption notice instead of the
   * full completion result. Set BEFORE the signal goes out (see
   * handleSubagentInterrupt) so a racing completion is classified correctly;
   * reverted if the teardown fails so a still-live child keeps its normal
   * completion path.
   */
  userInterrupted?: boolean;
  /** Epoch ms when the interrupt was requested (the notice's requestedAt). */
  interruptedAt?: number;
  /** Actor attribution for the interruption notice (see interruptingActor()). */
  interruptionActor?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;
/**
 * True once the owning session has fired `session_shutdown`. Set as the FIRST
 * statement of the shutdown handler. In pi's print mode (`pi --print`, the
 * headless background spawner) the runtime UNCONDITIONALLY disposes the session
 * after the first turn — `session.dispose()` → `extensionRunner.invalidate()` —
 * after which ANY `ctx`/`pi` access (including `ctx.hasUI` and
 * `pi.sendMessage`) throws "extension ctx is stale". The `subagent` tool
 * returns before turn 1 ends, so the fire-and-forget `watchSubagent().then/.catch`
 * delivery can fire AFTER the invalidate; without this flag that delivery
 * throws in the unhandled promise chain → uncaught → the spawner exits 1 → its
 * session_shutdown sweep kills its still-running (grand)children. Every
 * post-session delivery path checks this flag BEFORE touching `latestCtx`/
 * `latestPi` (a try/catch alone is not enough — the throw is the hazard).
 */
let sessionEnded = false;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Test seam: when non-null, the spawn path calls this instead of the real
 * `watchSubagent`, so a unit test can drive the fire-and-forget
 * `watchSubagent(...).then/.catch` delivery chain deterministically (e.g. to
 * prove the post-session `sessionEnded` guard skips delivery into a stale
 * ctx/pi). Set via `__test__.setWatchSubagentForTest`; null in production.
 */
let watchSubagentForTest: ((
  running: RunningSubagent,
  signal: AbortSignal,
) => Promise<SubagentResult>) | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

/**
 * Expandable wrapper around a custom-message renderer.
 *
 * pi's `registerMessageRenderer` returns a plain `Component` that the TUI hosts
 * inside its own `CustomMessageComponent` - a bare `Container` with no mouse
 * handling. Built-in expandable entries (tool results, branch/compaction
 * summaries) are clickable because they wrap their content in their own
 * `MouseRegion`; a renderer-returned component gets no such region, so a left
 * click falls through to text selection and the only way to expand it is the
 * global Ctrl+O toggle.
 *
 * This wrapper supplies that handler via `claimLeftClick` (see
 * `mouse-toggle.ts` for how the TUI's mouse dispatcher delivers the
 * synthesized click and re-renders on `{ handled: true }`). Note the renderer
 * callback itself only runs once per message, so the expansion state must live
 * on the component (plus the per-message map below), not in the render
 * closure.
 */
class ExpandableMessageComponent extends Container {
  private expanded: boolean;
  private build: (width: number, expanded: boolean, theme: any) => string[];
  private theme: any;
  private bg: (text: string) => string;
  private onToggle: (expanded: boolean) => void;

  constructor(
    build: (width: number, expanded: boolean, theme: any) => string[],
    initialExpanded: boolean,
    theme: any,
    bg: (text: string) => string,
    onToggle: (expanded: boolean) => void,
  ) {
    super();
    this.build = build;
    this.expanded = initialExpanded;
    this.theme = theme;
    this.bg = bg;
    this.onToggle = onToggle;
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    return claimLeftClick(event, () => {
      this.expanded = !this.expanded;
      this.onToggle(this.expanded);
    });
  }

  render(width: number): string[] {
    const box = new Box(1, 1, this.bg);
    box.addChild(new Text(this.build(width, this.expanded, this.theme).join("\n"), 0, 0));
    return ["", ...box.render(width)];
  }
}

/**
 * Per-message click-to-expand state, keyed by the message object.
 *
 * pi's `CustomMessageComponent` rebuilds (re-invoking the registered renderer)
 * on theme changes, output-pad changes, and Ctrl+O toggles. Seeding a fresh
 * component from `options.expanded` (the global toggle) alone would silently
 * discard the user's per-message click choice on any such rebuild. Keeping
 * the choice here lets a rebuild restore it. A *change* in the value of
 * `options.expanded` signals a global Ctrl+O toggle (or a session restore,
 * which creates a fresh message object and therefore a fresh entry) and
 * overrides the click choice - matching built-in components, where Ctrl+O
 * wins over clicks. A WeakMap, so state is garbage-collected with the message.
 */
const messageExpansionState = new WeakMap<
  object,
  { lastGlobal: boolean; expanded: boolean }
>();

function createExpandableMessageComponent(
  message: unknown,
  options: { expanded: boolean },
  theme: any,
  build: (width: number, expanded: boolean, activeTheme: any) => string[],
  bg: (text: string) => string,
): ExpandableMessageComponent {
  let expanded: boolean;
  let onToggle: (next: boolean) => void = () => {};
  if (typeof message === "object" && message !== null) {
    let state = messageExpansionState.get(message);
    if (!state) {
      state = { lastGlobal: options.expanded, expanded: options.expanded };
      messageExpansionState.set(message, state);
    } else if (state.lastGlobal !== options.expanded) {
      // Global toggle (Ctrl+O) or session restore: overrides the click choice.
      state.expanded = options.expanded;
    }
    state.lastGlobal = options.expanded;
    expanded = state.expanded;
    onToggle = (next: boolean) => {
      state.expanded = next;
    };
  } else {
    expanded = options.expanded;
  }
  return new ExpandableMessageComponent(build, expanded, theme, bg, onToggle);
}

function updateWidget() {
  // sessionEnded: once the session shut down, latestCtx is stale (print mode
  // disposes it after turn 1) and ANY property read throws — check the flag
  // before the first access. !hasUI: headless sessions have no widget to render.
  if (sessionEnded || !latestCtx?.hasUI) return;

  // Interrupted runs stay in the map until their watcher observes the
  // torn-down surface and removes them (see watchSubagent); hide them so the
  // widget entry disappears the moment an interrupt is requested.
  const visible = visibleRunningSubagents();
  if (visible.length === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(visibleRunningSubagents(), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 *
 * `omitControlTools` (background children, plan D4): withhold the control
 * tools from the allowlist so `--tools` agrees with the child side, which
 * refuses to REGISTER ask_question in background children (isBackgroundChild
 * in subagent-done.ts). The parent must not advertise a tool the child will
 * never have.
 */
export function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean; omitControlTools?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;
  const omitControlTools = opts?.omitControlTools ?? false;

  // No explicit tool restriction and no spawning grant → don't pass --tools at
  // all (the child keeps its default toolset).
  if (requested.length === 0 && !grantSpawning) return null;

  const allow = new Set(requested);
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  if (!omitControlTools) {
    for (const tool of SUBAGENT_CONTROL_TOOLS) {
      allow.add(tool);
    }
  }

  return [...allow].join(",");
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools, plus the always-on extensions
  // (config.json `alwaysOnExtensions`) that must guard every subagent
  // regardless of its tool loadout (e.g. bash-guard); per-agent
  // frontmatter exclusions (`-path`) may remove a global entry for one role.
  // A null allowlist means the spawn was intentionally unrestricted (e.g. a
  // fork clone) and is replayed as-is: it keeps every global extension, so
  // always-on extensions installed globally are still loaded through normal
  // discovery.
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));
    // Restricted children disable global extension discovery and re-enable an
    // explicit, pinned set of extensions (the tool-backing + always-on ones
    // below). Pin that set against drift: `--offline` disables startup network
    // operations (pi 1.3.0: "same as PI_OFFLINE=1"), so package resolution at
    // startup cannot fetch/install and silently widen the extension set the
    // child boots with. Unrestricted children (null allowlist) keep normal
    // discovery and are left alone. Resume replays this from the same builder,
    // so the flag survives resume with no separate change.
    parts.push("--offline");

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = getToolExtensionPath(tool);
      // `builtin:<name>` specs are resolved by the pi CLI itself (pi >=1.0.0
      // `-e` accepts them) — there is no file to check, so they pass through
      // the existsSync gate verbatim. A plain path must exist on disk or it
      // is silently dropped (the tool simply is not granted).
      if (extPath && (extPath.startsWith("builtin:") || existsSync(extPath))) extPaths.add(extPath);
    }
    for (const extPath of resolveAlwaysOnExtensionPaths(loadout.alwaysOnExtensions ?? [])) {
      extPaths.add(extPath);
    }
    // Restricted children disable global extension discovery; re-enable the
    // herdr integration extension (lifecycle reporting) so `herdr agent
    // prompt` steering works for them. No-op outside herdr.
    if (muxKind() === "herdr") {
      const herdrState = getHerdrStateExtensionPath();
      if (herdrState) extPaths.add(herdrState);
    }
    for (const extPath of extPaths) {
      parts.push("-e", shellEscape(extPath));
    }
  }
}

/**
 * Resolve an always-on extension entry (absolute or `~/`-prefixed) to the
 * child-facing path: absolute paths are passed through, `~/` expands against
 * this process's home. Returns null for entries that cannot be expanded.
 */
function resolveAlwaysOnExtensionEntry(entry: string): string | null {
  const value = entry.trim();
  if (!value) return null;
  if (value.startsWith("~/")) {
    const home = homedir();
    if (!home) return null;
    return join(home, value.slice(2));
  }
  if (isAbsolute(value)) return value;
  return null;
}

// Test hook: overrides the config.json `alwaysOnExtensions.paths` source so
// tests don't depend on the host machine's config.json. null = use the real
// module-load config.
let alwaysOnConfigOverride: string[] | null = null;
export function __setAlwaysOnExtensionsConfigForTest(paths: string[] | null): void {
  alwaysOnConfigOverride = paths;
}

// Canonical form for comparing always-on extension paths: homedir-expanded
// (done by the caller) plus symlink resolution, so an exclusion written as
// `~/pi/agent/extensions/bash-guard` matches a global entry written as the
// absolute path, and both match through symlinks.
function canonicalExtensionPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The always-on extensions for child pi processes: config.json
 * `alwaysOnExtensions.paths` (validated once at module load) plus the
 * agent's `always-on-extensions` frontmatter entries, both re-validated per
 * spawn so `~/` entries track this process's home. Frontmatter entries may
 * also be SUBTRACTIVE: a leading `-` marks an exclusion, removing the
 * matching global entry from this agent's loadout (e.g. one role that is
 * cleared to run what the guard blocks). An exclusion that matches nothing
 * is a warning, not a failure. Missing paths are dropped with a console
 * warning, so a deleted/renamed extension degrades to "no guard" loudly
 * instead of silently.
 */
export function resolveAlwaysOnExtensionPaths(extraEntries: string[] = []): string[] {
  const configured = alwaysOnConfigOverride ?? SUBAGENT_CONFIG.alwaysOnExtensions.paths;
  const additions: string[] = [];
  const exclusions: string[] = [];
  for (const entry of extraEntries) {
    const value = entry.trim();
    if (value.startsWith("-") && value.length > 1) {
      exclusions.push(value.slice(1).trim());
    } else {
      additions.push(entry);
    }
  }
  const raw = { alwaysOnExtensions: { paths: [...configured, ...additions] } };
  const { paths, errors } = parseAlwaysOnExtensionsConfig(raw, "config.json");
  for (const error of errors) console.warn(`[subagents] ${error}`);
  const resolved = paths
    .map((entry) => resolveAlwaysOnExtensionEntry(entry))
    .filter((p): p is string => p !== null && existsSync(p));

  if (exclusions.length === 0) return resolved;

  const exclude = new Set<string>();
  for (const entry of exclusions) {
    const abs = resolveAlwaysOnExtensionEntry(entry);
    if (!abs) {
      throw new Error(
        `Invalid always-on-extensions exclusion "-${entry}": must be an absolute or ~/ path`,
      );
    }
    exclude.add(canonicalExtensionPath(abs));
  }
  const kept = resolved.filter((p) => !exclude.has(canonicalExtensionPath(p)));
  if (kept.length === resolved.length) {
    console.warn(
      `[subagents] always-on-extensions exclusion matched nothing: ${exclusions.join(", ")}`,
    );
  }
  return kept;
}

// The bash-guard-mode frontmatter values and their meaning. Parsed RAW
// (lowercase-trim) and validated here; the child receives the accepted value
// as PI_BASH_GUARD_MODE. `off` means "unguarded by definition", so it needs no
// loaded guard. `read-only`/`floor`/`prompt` all REQUIRE bash-guard to be
// loaded into the child or the env var dangles into a void (see S4).
const BASH_GUARD_MODES = ["off", "prompt", "floor", "read-only"] as const;
/** Modes that require the bash-guard extension to actually be loaded. */
const BASH_GUARD_MODES_REQUIRING_GUARD = ["read-only", "floor", "prompt"] as const;

/**
 * Validate a parsed (lowercase-trimmed) bash-guard-mode value at launch time.
 * Returns null when the mode is absent or valid, and the tool-error message
 * string when it is present but invalid. Failing here (not at parse) keeps
 * discovery and the agent list healthy while guaranteeing no child ever starts
 * with a mistyped mode. Directly testable, so it is exposed on __test__.
 */
export function validateBashGuardMode(
  agentName: string,
  mode: string | undefined | null,
  sourceFile: string | undefined,
): string | null {
  if (mode == null) return null;
  if ((BASH_GUARD_MODES as readonly string[]).includes(mode)) return null;
  return (
    `agent ${agentName} has invalid bash-guard-mode '${mode}' ` +
      `(expected off, prompt, floor, or read-only) in ${sourceFile ?? "(unknown source)"}`
  );
}

/**
 * True when `path` resolves to a loadable bash-guard extension, i.e. its
 * canonical (symlink-resolved) basename is `bash-guard` — the documented
 * install name (the `~/.pi/agent/extensions/bash-guard` symlink or a repo
 * checkout dir). Used to fail-closed: an always-on extension set that holds
 * some extension OTHER than bash-guard must not satisfy a guard-requiring
 * mode.
 */
function isBashGuardExtensionPath(path: string): boolean {
  try {
    return basename(canonicalExtensionPath(path)) === "bash-guard";
  } catch {
    return false;
  }
}

/**
 * Fail-closed spawn guard for bash-guard modes that REQUIRE the guard loaded
 * (read-only | floor | prompt). Called from launchSubagent right after
 * agentDefs are resolved and before the claude/pi branch split and the pi
 * command is built, so a `cli: claude` child is refused before any surface is
 * created. The `mode` passed is the same value the loadout later snapshots
 * (loadout.bashGuardMode = agentDefs.bashGuardMode ?? null).
 *
 * Returns a spawn-error string when the mode cannot take effect (never a
 * silent unguarded child), and null when the spawn may proceed. The check
 * applies ONLY to the modes that require the guard to be active —
 * read-only | floor | prompt. Mode `off` (and an absent mode) skips the check
 * entirely: "off" means unguarded by definition, so a missing guard is the
 * requested outcome. `launchSubagent` gates on the mode before calling.
 *
 * 1. `cli: claude` → the guard is a pi extension, so it cannot load.
 * 2. bash-guard must itself be in the RESOLVED always-on extension set
 *    (matched by canonical path, not just "some extension present").
 * 3. If bash-guard resolves but the agent also carries a `-` exclusion entry,
 *    warn (not fail): exclusions are by path, the spawner cannot verify which
 *    extension was removed, so the user must confirm the guard survived.
 */
export function assertBashGuardLoaded(
  agentName: string,
  mode: string,
  cli: string | undefined,
  alwaysOnExtensions: string[] | undefined,
): string | null {
  // Only the guard-requiring modes reach the checks below. Anything else
  // (off, absent, or an already-refused value) proceeds without a guard check.
  if (!(BASH_GUARD_MODES_REQUIRING_GUARD as readonly string[]).includes(mode)) {
    return null;
  }

  // (1) The guard is a pi extension; the Claude-CLI child path cannot load it.
  if (cli === "claude") {
    return (
      `bash-guard-mode requires the pi CLI (the guard is a pi extension); ` +
        `agent ${agentName} cannot use it with cli: claude`
    );
  }

  // (2) Resolve the always-on set and require bash-guard ITSELF to be present.
  const resolved = resolveAlwaysOnExtensionPaths(alwaysOnExtensions ?? []);
  if (!resolved.some(isBashGuardExtensionPath)) {
    return (
      `agent ${agentName} sets bash-guard-mode: ${mode} but bash-guard is not in the ` +
        `resolved always-on extensions (resolved: ${
          resolved.length > 0 ? resolved.join(", ") : "none"
        }); install it and add it to alwaysOnExtensions (config.json) or ` +
        `always-on-extensions (agent frontmatter)`
    );
  }

  // (3) bash-guard survives, but a `-` exclusion was also declared. We cannot
  //     verify by path which extension was excluded, so warn for the user to
  //     confirm the guard survived (not a hard error).
  const hasExclusion = (alwaysOnExtensions ?? []).some(
    (e) => e.trim().startsWith("-") && e.trim().length > 1,
  );
  if (hasExclusion) {
    console.warn(
      `[subagents] agent '${agentName}' sets bash-guard-mode: ${mode} and bash-guard ` +
        `resolves (resolved: ${resolved.join(", ")}), but it also declares a '-' ` +
        `always-on-extensions exclusion - the spawner cannot verify which extension ` +
        `was excluded; confirm bash-guard still loads in the child`,
    );
  }

  return null;
}

/**
 * The `PI_BASH_GUARD_MODE` env prefix part for a bash-guard mode, or null when
 * no mode should be emitted. Used identically by the spawn path (from the
 * live agent definition) and the resume path (from the loadout snapshot), so
 * the var they emit cannot drift. `null` mode = agent had no field → no env
 * (bash-guard's own heuristic applies), which is also how a pre-field snapshot
 * reads back (missing key → treated as null).
 */
export function bashGuardModeEnvPart(mode: string | null): string | null {
  if (mode == null) return null;
  return `PI_BASH_GUARD_MODE=${shellEscape(mode)}`;
}

/**
 * The shared head of the pi launch AND resume command: the binary, the
 * explicit session file, the explicit non-interactive mode for headless
 * surfaces, and the subagent-done extension. One helper so the two paths
 * cannot drift.
 *
 * D3 (background): a `bg:` surface runs pi headless. `--print` is emitted
 * explicitly (the plan's `pi --session <file> --print <prompt>` form) rather
 * than relying on pi inferring print mode from non-TTY stdout — the launch
 * stays well-defined regardless of what stdout is attached to. Pane launches
 * are untouched (interactive TUI). On resume the surface is re-resolved, so
 * a resumed background child gets `--print` exactly like its original launch.
 */
export function buildPiLaunchParts(sessionFile: string, surface: string): string[] {
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(sessionFile));
  if (kindOf(surface) === "background") parts.push("--print");
  // Load the subagent-done extension so the agent can self-terminate
  // (and report its park/wait state) if needed.
  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));
  return parts;
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      waitingReason: read.activity.waitingReason,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Which subagents of THIS spawner session claim an explicit spawn name.
 * Checks, in order: subagents currently running, names reserved by parallel
 * in-flight spawns, and names already recorded in the spawner's persistent
 * registry (i.e. subagents that ran and finished earlier in this session).
 * Returns no conflict when the name is free on all three counts. `registry`
 * is this spawner's registry only - names owned by other sessions are out of
 * scope, matching the per-session name space of subagent_message.
 */
function nameCollisionForSpawn(
  name: string,
  registry?: NameRegistry,
): {
  running?: RunningSubagent;
  reserved?: boolean;
  registryEntry?: NameRegistryEntry;
} {
  const running = Array.from(runningSubagents.values()).find((r) => r.name === name);
  if (running) return { running };
  if (reservedNames.has(name)) return { reserved: true };
  const registryEntry = registry?.[name];
  if (registryEntry) return { registryEntry };
  return {};
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string; ambiguous?: boolean } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`, ambiguous: true };
}

/**
 * Running subagents that should still appear in the widget. Interrupted runs
 * stay in the map until their watcher observes the torn-down surface and
 * removes them; hiding them makes the widget entry disappear the moment an
 * interrupt is requested.
 */
function visibleRunningSubagents(): RunningSubagent[] {
  return Array.from(runningSubagents.values()).filter((running) => !running.userInterrupted);
}

/** Hint listing the currently running subagents for "unknown target" errors. */
function runningTargetHint(): string {
  const targets = [
    ...new Map(
      Array.from(runningSubagents.values()).map((running) => [running.id, `${running.name} [${running.id}]`] as const),
    ).values(),
  ];
  return targets.length
    ? ` Currently running: ${targets.join(", ")}.`
    : " No subagents are currently running.";
}

/**
 * Resolve a subagent_interrupt target by exact id or exact name. EXACTLY one
 * of the two is required (both or neither is a clear error); the given one
 * must name a currently-running subagent. A target that is not currently
 * running (already finished, unknown) is a clear error — aborts of finished
 * handles never fall through to a resume.
 */
function resolveRunningForInterrupt(params: { id?: unknown; name?: unknown }):
  | { running: RunningSubagent }
  | { error: string } {
  const id = typeof params.id === "string" ? params.id.trim() : "";
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (id && name) {
    const err = `Provide exactly one of the subagent's 'id' or 'name' (got both "${id}" and "${name}").`;
    return { error: err };
  }
  if (!id && !name) {
    const err = "Provide exactly one of the running subagent's `id` or `name` (got neither).";
    return { error: err };
  }

  if (id) {
    const running = runningSubagents.get(id);
    if (!running) return { error: `No running subagent with id "${id}".${runningTargetHint()}` };
    return { running };
  }

  const resolved = resolveRunningByName(name);
  if ("error" in resolved) return { error: resolved.error };
  return { running: resolved.running };
}

/**
 * Who requested an interrupt: "main_agent" for a top-level session, or the
 * calling subagent's runtime name when a subagent spawns its own children.
 * Captured from the caller environment (the same PI_SUBAGENT_NAME the
 * extension already reads on children), never from tool arguments.
 */
function interruptingActor(): string {
  return process.env.PI_SUBAGENT_NAME || "main_agent";
}

/** Concise one-line interruption notice (steered as the run's only result). */
export function formatInterruptedNotice(
  name: string,
  actor: string,
  elapsed: number,
  logPath?: string,
): string {
  const base = `Sub-agent "${name}" was interrupted by ${actor} (${formatElapsed(elapsed)}). No result will follow.`;
  // Plan risk-1: a background (headless) run leaves no pane — name its log
  // file so the orchestrator can inspect what the child did before dying.
  return logPath ? `${base}\nLog: ${logPath}` : base;
}

// ── S3: one-shot model fallback ────────────────────────────────────────────────

/**
 * The pi thinking levels a `:thinking` model suffix may name. "off" is the
 * ABSENCE of a suffix (models without reasoning run with none), not a level.
 */
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** A model + thinking level pair as it will be launched (`--model <model>[:<thinking>]`). */
interface ModelSelection {
  model?: string;
  thinking?: string;
}

/** The spawner's live model/thinking, used by `model-fallback: inherit`. */
interface ParentModelDefaults {
  model?: string;
  thinking?: string;
}

/**
 * Split a `provider/model[:thinking]` spec. The model part must contain at
 * least one `/`; the optional thinking part must be a valid pi thinking level
 * (an "off" model runs with no suffix — it is not a level). Returns null when
 * the shape is wrong.
 */
export function splitModelThinking(raw: string): { model: string; thinking?: string } | null {
  const v = raw.trim();
  if (!v) return null;
  let model = v;
  let thinking: string | undefined;
  const idx = v.lastIndexOf(":");
  if (idx !== -1) {
    model = v.slice(0, idx).trim();
    const t = v.slice(idx + 1).trim().toLowerCase();
    if (!t || !THINKING_LEVELS.has(t)) return null;
    thinking = t;
  }
  if (!model.includes("/")) return null;
  // No empty or dangling model part ("provider/", "/model").
  if (model.startsWith("/") || model.endsWith("/")) return null;
  return thinking ? { model, thinking } : { model };
}

/**
 * Validate the raw `model-fallback` frontmatter value at launch time (same
 * fail-closed pattern as bash-guard-mode: parse is lenient, launch refuses).
 * Returns null when the field is absent or valid, or the tool-error message —
 * naming the raw value and the source file — when it is present but invalid.
 */
export function validateModelFallback(
  agentName: string,
  raw: string | undefined | null,
  sourceFile: string | undefined,
): string | null {
  if (raw == null) return null;
  if (raw.toLowerCase() === "inherit") return null;
  if (splitModelThinking(raw)) return null;
  return (
    `agent ${agentName} has invalid model-fallback '${raw}' ` +
      `(expected 'inherit' or 'provider/model[:thinking]') in ${sourceFile ?? "(unknown source)"}`
  );
}

/**
 * Discovery-time visibility for a bad `model-fallback`: one console.warn per
 * (agent, file, value) per session, mirroring warnInvalidBashGuardModeOnce.
 * Keeps subagents_list healthy while the spawn itself is still refused.
 */
const warnedModelFallbacks = new Set<string>();
function warnInvalidModelFallbackOnce(agent: AgentDefinition): void {
  const raw = agent.modelFallback?.trim();
  if (!raw || raw.toLowerCase() === "inherit" || splitModelThinking(raw)) return;
  const key = `${agent.name}|${agent.sourceFile ?? "?"}|${raw}`;
  if (warnedModelFallbacks.has(key)) return;
  warnedModelFallbacks.add(key);
  console.warn(
    `[subagents] agent '${agent.name}' has invalid model-fallback '${raw}' ` +
      `(expected 'inherit' or 'provider/model[:thinking]') in ${agent.sourceFile ?? "(unknown source)"}; ` +
      `spawning it will be refused until the value is fixed`,
  );
}

/**
 * The spawner's LIVE model and thinking level (the immediate spawner, not the
 * top-level session — a nested spawner passes its own live selection down).
 * Verified against pi 1.3.0: the tool's ExtensionContext exposes `model`
 * (resolved at call time) and `thinkingLevel`.
 */
export function resolveParentModelDefaults(ctx: ExtensionContext): ParentModelDefaults {
  const m = ctx.model as { provider?: unknown; id?: unknown } | undefined;
  const model =
    typeof m?.provider === "string" && typeof m?.id === "string"
      ? `${m.provider}/${m.id}`
      : undefined;
  return { model, thinking: ctx.thinkingLevel ?? undefined };
}

/**
 * Resolve the primary run's effective model/thinking — the selection the
 * primary child is actually launched with (loadout: `params.model ?? agent
 * model`; thinking from the agent field or a `:thinking` suffix on the model
 * spec). The parent's live model is deliberately NOT part of this: a
 * model-less spawn launches with pi's session default, and the selection is
 * reported as `{}` when nothing is configured (the fallback comparison then
 * always retries, which is safe — the retry is what carries a real model).
 */
export function resolvePrimaryModelSelection(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): ModelSelection {
  const raw = params.model ?? agentDefs?.model;
  if (!raw) return {};
  const parsed = raw.includes(":") ? splitModelThinking(raw) : null;
  const model = parsed?.model ?? raw;
  const thinking = agentDefs?.thinking ?? parsed?.thinking;
  return { model, thinking };
}

/**
 * Resolve the `model-fallback` frontmatter to the retry's model/thinking.
 * Returns undefined when no fallback is configured. `inherit` copies the
 * spawner's LIVE model (not the top-level session); thinking precedence is
 * primary run's thinking > spawner's live thinking > the fallback spec's own
 * `:thinking`.
 */
export function resolveFallbackModelAndThinking(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
  parent: ParentModelDefaults,
  primary: ModelSelection,
): ModelSelection | undefined {
  const raw = agentDefs?.modelFallback?.trim();
  if (!raw) return undefined;
  const spec = raw.toLowerCase() === "inherit"
    ? { model: parent.model, thinking: undefined as string | undefined }
    : splitModelThinking(raw);
  if (!spec) return undefined; // bad value: the launch is refused earlier
  const thinking = primary.thinking ?? parent.thinking ?? spec.thinking;
  return spec.model ? { model: spec.model, thinking } : undefined;
}

function normalizeThinking(value?: string): string | undefined {
  return value?.trim() ? value.trim().toLowerCase() : undefined;
}

/** Same model AND same effective thinking level (undefined === off). */
export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return !!a.model && a.model === b.model && normalizeThinking(a.thinking) === normalizeThinking(b.thinking);
}

/**
 * One-shot fallback trigger. NEVER retries a user-cancellation (S2:
 * `interrupted` or `error: "cancelled"`). Retries on a provider/agent error
 * message, a non-zero exit, or a run that produced no non-whitespace assistant
 * text. `hasAssistantText === undefined` (unknown) is not a trigger.
 */
export function shouldRetryWithFallback(result: {
  error?: string;
  interrupted?: boolean;
  errorMessage?: string;
  exitCode?: number;
  hasAssistantText?: boolean;
}): { retry: boolean; reason?: string } {
  if (result.interrupted === true || result.error === "cancelled") return { retry: false };
  if (result.errorMessage) return { retry: true, reason: `provider/agent error: ${result.errorMessage}` };
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    return { retry: true, reason: `exit code ${result.exitCode}` };
  }
  if (result.hasAssistantText === false) return { retry: true, reason: "no assistant response text" };
  return { retry: false };
}

interface FallbackAttribution {
  from?: string;
  to: string;
  /** The retry's frozen thinking level (undefined = none). */
  thinking?: string;
  reason: string;
  failedSessionFile?: string;
}

/**
 * Decide whether a finished primary run gets the one-shot fallback retry:
 * the trigger fired, a fallback is configured, and it differs from the
 * primary's effective selection (a same-model+thinking retry is skipped and
 * the primary result is reported as-is). Pure, so it is directly unit-tested.
 */
export function fallbackDecision(
  primaryResult: SubagentResult,
  fallback: ModelSelection | undefined,
  primary: ModelSelection,
): { retry: boolean; attribution?: FallbackAttribution; skippedSameSelection?: boolean } {
  const decision = shouldRetryWithFallback(primaryResult);
  if (!decision.retry) return { retry: false };
  if (!fallback?.model) return { retry: false };
  if (sameModelSelection(fallback, primary)) {
    return { retry: false, skippedSameSelection: true };
  }
  return {
    retry: true,
    attribution: {
      ...(primary.model ? { from: primary.model } : {}),
      to: fallback.model,
      ...(fallback.thinking ? { thinking: fallback.thinking } : {}),
      reason: decision.reason ?? "primary run failed",
      ...(primaryResult.sessionFile ? { failedSessionFile: primaryResult.sessionFile } : {}),
    },
  };
}


/**
 * Deliver the one concise interruption notice for a cancelled run instead of
 * the normal completion. Returns true when the caller must skip the normal
 * completion path entirely.
 */
function finalizeInterruptedRun(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: Pick<SubagentResult, "exitCode" | "elapsed" | "interrupted" | "backgroundLogPath"> & { sessionFile?: string; sessionId?: string },
): boolean {
  if (result.interrupted !== true) return false;
  // Post-session guard: this is called from an async delivery handler that has
  // intermediate awaits (the model-fallback retry), so the session may have
  // shut down — and invalidated the ctx/pi — between the handler's entry check
  // and this point. Delivering now would throw in the unhandled chain.
  if (sessionEnded) return false;
  updateWidget();
  const requestedAt = new Date(running.interruptedAt ?? Date.now()).toISOString();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: formatInterruptedNotice(running.name, running.interruptionActor ?? "main_agent", result.elapsed, result.backgroundLogPath),
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile ?? running.sessionFile,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        interrupted: true,
        interruption: {
          actor: running.interruptionActor ?? "main_agent",
          requestedAt,
        },
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
  return true;
}

/**
 * Type a follow-up message into a running subagent's live pane. On herdr,
 * `sendMessage` goes through `herdr agent prompt` (bracketed paste,
 * multi-line safe, refused with `agent_blocked` when the child sits at an
 * approval/question dialog). The raw-pane fallback (tmux, or herdr before
 * the agent is recognised) still flattens to a single line because each
 * newline submits a turn in the child's TUI editor.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendMessage,
): { ok: true } | { error: string } {
  try {
    send(running.surface, message);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via the multiplexer: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendMessage,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.userInterrupted) {
    const err = `Subagent "${running.name}" was interrupted and is shutting down; it cannot receive new messages.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, status: "interrupted" },
    };
  }
  // D4 (decision 2): a running background child has no TUI to steer into,
  // and there is no reply-delivery path for ask_question, so a steer would
  // be silently dropped — refuse with the documented message. Resume-after-
  // finish is unaffected (that path re-launches the session in a fresh,
  // re-resolved surface and never touches this live one).
  if (kindOf(running.surface) === "background") {
    const err =
      `background subagent "${running.name}" cannot be steered (no TUI); ` +
      `wait for completion and resume, or interrupt it`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, status: "background_not_steerable" },
    };
  }
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

/**
 * Cancel a running subagent. The run is marked user-interrupted BEFORE any
 * surface is touched, so a racing completion (a child that exits on its own
 * while the signal is in flight) is classified as interrupted and the watcher
 * steers the concise notice instead of the full result. Then the backend
 * cancellation signal (Escape) stops the in-flight turn and the existing
 * kill/close path (closeRunningSurface) terminates the child process and
 * closes the pane — Escape alone may only park the session (pi's abort path
 * keeps it open for inspection), so the close is what guarantees termination.
 * If the teardown fails, the marker is reverted so a still-live child keeps
 * its normal completion path (a teardown error that says the pane is already
 * gone is the opposite case: the child is dead, the marker stays).
 *
 * Note: the multiplexer backends close synchronously, but the background
 * backend's close is bounded-async (process-group SIGTERM + up to 5s await)
 * — the promise contract keeps both on one shared close path. A rejected
 * close (background timeout) retains the record fail-closed, so a retry is
 * possible; the close below is AWAITED inside the same try, so a rejected
 * close is caught and classified like any other teardown failure (no
 * unhandled rejection).
 */
async function handleSubagentInterrupt(
  params: { id?: unknown; name?: unknown },
  opts: {
    signal: (surface: string, signal?: AbortSignal) => Promise<void>;
    close: (running: RunningSubagent) => Promise<void>;
  } = { signal: interrupt, close: closeRunningSurface },
) {
  const resolved = resolveRunningForInterrupt(params);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], details: { error: resolved.error } };
  }

  const running = resolved.running;
  // S2 defensive cleanup: an interrupted child that had just called
  // ask_question leaves its `${sessionFile}.ask` signal file on disk (its own
  // watcher never got to deliver+delete it). A later same-name respawn in the
  // same cwd reuses the same session file path, and its fresh watcher would
  // otherwise deliver the DEAD child's question to the parent. Best-effort
  // unlink below (teardown success AND revert paths) removes that stale
  // signal; a live child's in-flight question is unaffected because it is
  // re-written by the child on its next ask.
  const unlinkStaleAsk = (): void => {
    try {
      if (existsSync(`${running.sessionFile}.ask`)) unlinkSync(`${running.sessionFile}.ask`);
    } catch {
      // Best-effort: nothing to do if the file is absent or already gone.
    }
  };
  if (running.cli === "claude") {
    const err = `Subagent "${running.name}" runs via the Claude Code CLI and cannot be interrupted from here. Close its pane manually.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, status: "claude_not_supported" },
    };
  }
  if (running.userInterrupted) {
    const err = `Subagent "${running.name}" was already interrupted; its pane is shutting down. The interruption notice will arrive once it is torn down.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, status: "interrupt_already_requested" },
    };
  }

  // Mark BEFORE the signal goes out: a racing completion (normal sentinel or
  // .exit sidecar read between the flag and the teardown) is then classified
  // as interrupted, and a child that finished before this call can never be
  // interrupted at all — it is no longer in runningSubagents, so the resolver
  // above already refused it.
  const previousUserInterrupted = running.userInterrupted;
  const previousInterruptedAt = running.interruptedAt;
  const previousActor = running.interruptionActor;
  const previousStatusState = running.statusState;
  running.userInterrupted = true;
  running.interruptedAt = Date.now();
  running.interruptionActor = interruptingActor();
  running.statusState = forceStatusAfterInterrupt(running.statusState, Date.now());
  updateWidget();

  try {
    await opts.signal(running.surface);
    await opts.close(running);
  } catch (error: any) {
    // The pane may already be gone (the child died in the same moment): that
    // is not a teardown failure — the child is dead and the watcher confirms
    // via its paneGone detection. Keep the interrupt marker in that case.
    if (!isSurfaceGoneError(error)) {
      running.userInterrupted = previousUserInterrupted;
      running.interruptedAt = previousInterruptedAt;
      running.interruptionActor = previousActor;
      running.statusState = previousStatusState;
      updateWidget();
      // Teardown failed: the child may be alive, but the .ask signal (if any)
      // was the child's just-written question — dropping it on a failed
      // teardown is the lesser evil: the child can re-ask, while a stale
      // signal would be delivered to a LATER same-name respawn's watcher.
      unlinkStaleAsk();
      const err = `Failed to interrupt subagent "${running.name}": ${error?.message ?? String(error)}`;
      return {
        content: [{ type: "text" as const, text: err }],
        details: { error: err, id: running.id, name: running.name, status: "interrupt_failed" },
      };
    }
    // The pane is gone: the child is dead and can never deliver its pending
    // question — clear the stale .ask so a later same-name respawn (same
    // session file) doesn't receive the dead child's question.
    unlinkStaleAsk();
  }

  // Teardown succeeded: the child's pending question can never be delivered
  // by its (now dead) watcher — clear the stale .ask signal (same reason as
  // above).
  unlinkStaleAsk();

  return {
    content: [{
      type: "text" as const,
      text:
        `Interrupted subagent "${running.name}": its turn was cancelled and its pane closed. ` +
        `The watcher will confirm the teardown and steer a concise interruption notice; no result will follow.`,
    }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;
  // Headless sessions (background children, pi --print top-level) have no UI
  // to supervise for: skip the interval entirely (its pi.sendMessage would
  // also be wasted turns in a headless process). sessionEnded must be checked
  // BEFORE latestCtx: once the session disposed, even reading ctx.hasUI throws
  // (stale ctx), so the flag is the only safe first check.
  if (sessionEnded || !latestCtx?.hasUI) return;

  statusInterval = setInterval(() => {
    if (sessionEnded) return; // in-flight tick racing the shutdown
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      // Interrupted runs are being torn down: no more supervision or status
      // transitions for them (the interruption notice is their only steer).
      if (running.userInterrupted) continue;
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  getSpawnSurface,
  getSpawnBackend,
  resolvedSpawnBackend,
  buildSubagentLaunchEnvParts,
  buildSubagentResumeEnvParts,
  __resetBackgroundLogAnnouncementForTest__,
  noteBackgroundSpawn,
  createSubagentSurface,
  getHerdrStateExtensionPath,
  shouldOpenTab,
  resolveSurfaceShape,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiLaunchParts,
  applySandboxToParts,
  resolveAlwaysOnExtensionPaths,
  __setAlwaysOnExtensionsConfigForTest,
  validateBashGuardMode,
  assertBashGuardLoaded,
  bashGuardModeEnvPart,
  buildPiPromptArgs,
  // S3: one-shot model fallback
  splitModelThinking,
  validateModelFallback,
  resolveParentModelDefaults,
  resolvePrimaryModelSelection,
  resolveFallbackModelAndThinking,
  sameModelSelection,
  shouldRetryWithFallback,
  fallbackDecision,
  deleteName,
  readNameRegistry,
  sessionHasAssistantText,
  launchSubagent,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  resolveRunningForInterrupt,
  visibleRunningSubagents,
  interruptingActor,
  formatInterruptedNotice,
  finalizeInterruptedRun,
  handleSubagentInterrupt,
  uniqueRunningName,
  reservedNames,
  nameCollisionForSpawn,
  steerSubagent,
  handleSubagentSteer,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  // Post-session (stale-ctx) guard: read/flip the flag, inspect/set the
  // captured ctx, drive the widget, and inject a watcher for the
  // fire-and-forget delivery tests.
  updateWidget,
  getSessionEnded: () => sessionEnded,
  setSessionEndedForTest: (v: boolean) => {
    sessionEnded = v;
  },
  setLatestCtxForTest: (ctx: ExtensionContext | null) => {
    const prev = latestCtx;
    latestCtx = ctx;
    return prev;
  },
  setWatchSubagentForTest: (fn: typeof watchSubagent | null) => {
    watchSubagentForTest = fn;
  },
  // Park-aware child task-wrapper preamble (plan PLANS-2026-10-20-child-park-hints.md)
  buildAutoExitModeHint,
  buildSummaryInstruction,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  // Headless sessions have no widget to render — skip the interval (and the
  // immediate first render) entirely. Behavior-neutral for interactive.
  // sessionEnded is checked BEFORE latestCtx: a disposed session's ctx throws
  // on ANY property read (see `sessionEnded`), so the flag is the only safe
  // first check when this runs from an async delivery handler after a retry.
  if (sessionEnded || !latestCtx?.hasUI) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Decide whether a spawn should open a dedicated tab (vs a pane split).
 * Pure so it can be unit-tested: a top-level session in "tabs" mode gets a tab;
 * a nested subagent (PI_SUBAGENT_SESSION set) gets a pane inside its own tab;
 * "panes" mode always uses a pane.
 */
export function shouldOpenTab(params: {
  surface: SpawnSurface;
  isSubagentSession: boolean,
}): boolean {
  return params.surface === "tabs" && !params.isSubagentSession;
}

/**
 * Decide the SURFACE SHAPE of a spawn, given the resolved backend. `shape` is
 * "tabs" or "panes" (from the spawn-surface policy); `isSubagentSession` is
 * whether this process is itself a subagent. Returns "tab" (dedicated
 * labelled tab), "pane" (split off the caller's pane) or "plain" (the plain
 * createSurface of the resolved backend — the shape key is IGNORED for the
 * background backend, plan D1: createSurface there yields `bg:<id>`, and
 * createSurfaceTab/createSurfaceSplit would throw by design). Pure so it can
 * be unit-tested; createSubagentSurface applies it.
 *
 * Shape policy (multiplexer backends only):
 *   - "tabs" mode + this process is the user's session (no PI_SUBAGENT_SESSION)
 *     → a new labelled tab, so first-level subagents don't crowd the main pane.
 *   - "tabs" mode + this process is itself a subagent → a pane split inside
 *     THIS subagent's own tab (HERDR_PANE_ID / TMUX_PANE point at us), so a
 *     subagent's children stay with their parent.
 *   - "panes" mode (default) → a pane split off the caller, as before.
 */
export function resolveSurfaceShape(params: {
  backendKind: string;
  shape: SpawnSurface;
  isSubagentSession: boolean;
}): "tab" | "pane" | "plain" {
  if (params.backendKind === "background") return "plain";
  return shouldOpenTab({ surface: params.shape, isSubagentSession: params.isSubagentSession })
    ? "tab"
    : "pane";
}

/**
 * Create the surface a subagent runs in, choosing between a pane split, a
 * dedicated tab (multiplexer backends) or the plain createSurface (the
 * background backend — the shape key is ignored, and its createSurfaceTab /
 * createSurfaceSplit refuse by design; this keeps a `tabs` config + bare
 * environment on the headless path instead of a throw).
 *
 * Returns the surface id (a pane/tab-root id for multiplexer backends, `bg:<id>`
 * for background). A tab surface is the tab's root pane; it is closed the same
 * way as a pane and its container auto-closes when the last pane in it dies.
 */
async function createSubagentSurface(
  name: string,
  effectiveCwd: string | null,
  fallbackCwd: string,
): Promise<string> {
  const backendKind = activeBackend().kind;
  const shape = resolveSurfaceShape({
    backendKind,
    shape: getSpawnSurface(),
    isSubagentSession: !!process.env.PI_SUBAGENT_SESSION,
  });
  if (shape === "tab") {
    return createSurfaceTab(name, effectiveCwd ?? fallbackCwd);
  }
  return createSurface(name);
}

/**
 * Close a subagent's surface. Both pane-split and tab surfaces are closed by
 * killing the root pane id: a tab's container auto-closes (herdr closes the
 * tab, tmux destroys the window) once its LAST pane dies, so closing only the
 * root pane never destroys still-running child panes that the tab holds.
 * Best-effort — a pane that is already gone is a no-op.
 */
function closeRunningSurface(running: RunningSubagent): Promise<void> {
  return closeSurface(running.surface);
}

// ── Child task-wrapper preamble (plan PLANS-2026-10-20-child-park-hints.md) ──
//
// #1 park-aware auto-exit preamble + #2 interim-report guard. Extracted as
// exported pure helpers so the task wrapper's mode hint and summary
// instruction are unit-testable without a full spawn. `autoExit` mirrors
// `agentDefs?.autoExit`; `grantSpawning` mirrors the non-empty
// `subagent_agents` check. The claude-CLI path (sends the raw task only) and
// the resume path (replays the original preamble from the child's own session
// file) are intentionally NOT routed through these.

/**
 * Build the child's "how the session ends" mode hint for its task wrapper.
 *
 * - autoExit && !grantSpawning: the common case — unchanged, byte-identical
 *   to the pre-change string (regression guard).
 * - autoExit && grantSpawning: park-aware variant — the child may still be
 *   running its own children when it "stops", so the session is parked (not
 *   ended) until the last pending child result is handled.
 * - interactive && !grantSpawning: unchanged interactive hint.
 * - interactive && grantSpawning: existing interactive hint + one sentence
 *   telling the child to keep processing its own children's results.
 */
export function buildAutoExitModeHint(autoExit: boolean, grantSpawning: boolean): string {
  if (autoExit) {
    if (!grantSpawning) {
      return "Complete your task autonomously. When you are finished, simply stop — your session ends automatically.";
    }
    return (
      "Complete your task autonomously. When you are finished, simply stop.\n" +
      "If you spawned subagents of your own, stopping does NOT end your session " +
      "while any of them is still running: the session stays parked, and each of " +
      "their results arrives as a new message that starts a continuation turn.\n" +
      "Only after the last pending result is handled does the session end " +
      "automatically — treat each result turn as a continuation of your task, not " +
      "a fresh task."
    );
  }
  if (!grantSpawning) {
    return "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  }
  return (
    "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane. " +
    "If you spawn subagents of your own, their results arrive as new messages; " +
    "keep processing them before considering the task finished."
  );
}

/**
 * Build the child's "summarize what you did" summary instruction.
 *
 * For the ungranted case the existing single sentence is unchanged (byte-
 * identical). For the granted case it appends the #2 interim-report guard: a
 * summary written while the child's own subagents are still running is NOT
 * delivered (the session is parked), so it must be a short, labelled interim
 * report; the real final report belongs in the turn that handles the last
 * pending result.
 */
export function buildSummaryInstruction(autoExit: boolean, grantSpawning: boolean): string {
  const base = autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  if (!grantSpawning) return base;
  const interim =
    "Your final report is only delivered when the session actually ends.\n" +
    "Any summary you write while your own subagents are still running is NOT " +
    'delivered to the orchestrator — if you must summarize at that point, keep ' +
    'it to a few lines and label it "interim report".\n' +
    "The real final report belongs in the turn that handles your last pending " +
    "result; make that message complete and self-contained.";
  return `${base}\n${interim}`;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null | undefined; getSessionId(): string; getSessionDir(): string };
    cwd: string;
  },
  // S3: internal launch overrides (not part of the public spawn tool schema).
  // The model-fallback retry uses `thinking` to FREEZE its resolved thinking
  // level in the retry's loadout: `null` means "launch with no level" and
  // must NOT fall back to the agent's default.
  launchOverrides?: { thinking?: string | null; out?: { surfaceId?: string } },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;

  // S3: validate the raw model-fallback at launch (not at parse, so discovery
  // and the agent list stay healthy), mirroring the bash-guard-mode check. A
  // mistyped fallback is refused here, before any surface or session file is
  // touched, so a broken agent can never spawn into a silent no-fallback.
  const modelFallbackError = validateModelFallback(
    params.agent ?? "(unnamed)",
    agentDefs?.modelFallback,
    agentDefs?.sourceFile,
  );
  if (modelFallbackError) throw new Error(modelFallbackError);

  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  // `params.name` is always a concrete string here: the spawn tool resolves it
  // (collision-checked, or auto-generated) before launchSubagent runs — the
  // optional type is just the tool's input schema. Bind a non-optional local.
  const name: string = params.name!;

  // S1: validate the raw bash-guard-mode at launch (not at parse, so discovery
  // and the agent list stay healthy). A mistyped mode is refused here, before
  // any surface or session file is touched, so no child ever starts unguarded.
  const bashGuardError = validateBashGuardMode(
    params.agent ?? "(unnamed)",
    agentDefs?.bashGuardMode,
    agentDefs?.sourceFile,
  );
  if (bashGuardError) throw new Error(bashGuardError);

  // S4: fail-closed bash-guard check, BEFORE the claude/pi branch split so a
  // `cli: claude` child with a guard-requiring mode is refused here (the guard
  // is a pi extension; the claude child path cannot load it). The loadout is
  // built later in the pi branch, so the mode used is the same value the
  // loadout will snapshot; the check itself only needs agentDefs. A mode that
  // requires the guard (read-only | floor | prompt) is refused unless bash-guard
  // itself is in the resolved always-on set. Mode `off` and an absent mode skip
  // the check entirely.
  const guardLoadError = assertBashGuardLoaded(
    params.agent ?? "(unnamed)",
    agentDefs?.bashGuardMode ?? "",
    agentDefs?.cli,
    agentDefs?.alwaysOnExtensions,
  );
  if (guardLoadError) throw new Error(guardLoadError);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Create the subagent's surface: a pane split (default) or a dedicated tab
  // (top-level spawn in "tabs" mode). Both are pane ids. Pause briefly so the
  // shell is ready before sending the launch command.
  const surface = await createSubagentSurface(name, effectiveCwd, targetCwdForSession);
  // S3 leak seam: the surface exists from here on. `out` (the internal launch
  // seam) exposes it to the caller so a LATE throw in the tail below — the
  // tail has no error path of its own, so a throwing sendLongCommand would
  // otherwise leak a live, unmonitored pane — can close it. The tail wraps in
  // try/finally: on a late throw the finally closes the surface before the
  // error propagates; on success nothing is closed (the watcher owns the
  // surface lifetime from the returned RunningSubagent). `out` is optional
  // and unused by the normal spawn path.
  if (launchOverrides?.out) launchOverrides.out.surfaceId = surface;
  let tailSucceeded = false;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);

    if (launchBehavior.seededSessionMode) {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
      });
    }

    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });
    const { inheritsConversationContext } = launchBehavior;

    // Build the task message
    // Only full-context fork mode inherits prior conversation state.
    // Blank-session modes need the wrapper instructions and artifact-backed handoff.
    // An agent with a non-empty subagent_agents list is granted the spawning
    // toolset and may only spawn the listed agents (enforced via PI_SUBAGENT_ALLOWED).
    const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
    const autoExit = !!(agentDefs?.autoExit);
    const modeHint = buildAutoExitModeHint(autoExit, grantSpawning);
    const summaryInstruction = buildSummaryInstruction(autoExit, grantSpawning);
    const identity = agentDefs?.body ?? null;
    const systemPromptMode = agentDefs?.systemPromptMode;
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = inheritsConversationContext
      ? params.task
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
    // ── Claude Code CLI path ──
    if (agentDefs?.cli === "claude") {
      const sentinelFile = `/tmp/pi-claude-${id}-done`;
      const pluginDir = join(SUBAGENTS_DIR, "plugin");

      const cmdParts: string[] = [];
      cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
      cmdParts.push("claude");
      cmdParts.push("--dangerously-skip-permissions");

      if (existsSync(pluginDir)) {
        cmdParts.push("--plugin-dir", shellEscape(pluginDir));
      }

      if (effectiveModel) {
        cmdParts.push("--model", shellEscape(effectiveModel));
      }

      const sp = agentDefs.body;
      if (sp) {
        cmdParts.push("--append-system-prompt", shellEscape(sp));
      }

      // Always pass the task as the prompt — even for resumed sessions,
      // the caller's task is the follow-up instruction.
      cmdParts.push(shellEscape(params.task));

      const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
      const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

      const launchScriptName = `${(name || "subagent")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
      const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

      sendLongCommand(surface, command, {
        scriptPath: launchScriptFile,
        scriptPreamble: [
          `# Claude Code subagent launch script for ${name}`,
          `# Generated: ${new Date().toISOString()}`,
          `# Surface: ${surface}`,
        ].join("\n"),
      });

      const running: RunningSubagent = {
        id,
        name: name,
        task: params.task,
        agent: params.agent,
        surface,
        startTime,
        sessionFile: subagentSessionFile,
        launchScriptFile,
        cli: "claude",
        sentinelFile,
        interactive: effectiveInteractive,
        statusState: createStatusState({
          source: "claude",
          startTimeMs: startTime,
        }),
      };
      if (kindOf(surface) === "background") {
        // Plan risk-1: announce the first headless spawn of this session.
        const logPath = backgroundLogPathOf(surface);
        if (logPath) noteBackgroundSpawn(name, logPath);
      }

    runningSubagents.set(id, running);
    tailSucceeded = true;
    return running;
  }

  // ── Pi CLI path ──

  // S3: the effective thinking level the run launches with. An explicit launch
  // override (the model-fallback retry freezing its resolved selection) wins
  // and is exact (`null` = no level, no agent-default fallback); otherwise the
  // agent field applies, with a `:thinking` suffix on the effective model as
  // the final fallback so the loadout matches what the run actually launches
  // and resume replays the frozen level.
  const piEffectiveThinking =
    launchOverrides?.thinking !== undefined
      ? launchOverrides.thinking ?? undefined
      : effectiveThinking ??
        (effectiveModel && effectiveModel.includes(":")
          ? splitModelThinking(effectiveModel)?.thinking
          : undefined);

  // Build pi command (shared head with the resume path — D3: --print for
  // bg: surfaces is applied inside buildPiLaunchParts so the two can't drift).
  const parts = buildPiLaunchParts(subagentSessionFile, surface);

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Default-deny model: when an agent restricts its tools (or is granted the
  // spawning toolset), we disable global extension discovery and re-enable only
  // the extensions backing the whitelisted tools. Bare/fork spawns with no tool
  // restriction keep their full default toolset and all global extensions.
  // D4 (background): omit the child control tools (ask_question) when the
  // resolved backend is background, so `--tools` agrees with the child side,
  // which withholds the tool's registration there (isBackgroundChild).
  // The `--tools` omission only matters for tool-RESTRICTED children (an
  // unrestricted child emits no `--tools` at all); for ALL background
  // children it is the child-side registration guard in subagent-done.ts
  // (isBackgroundChild) that actually withholds ask_question — this flag
  // keeps the parent-side allowlist from contradicting it.
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, {
    grantSpawning,
    omitControlTools: activeBackend().kind === "background",
  });

  // S7 Phase 2: `safe_bash` was removed (use `bash` + `bash-guard-mode`
  // instead). Warn once per session when the child's effective tools still
  // list it — the spawn proceeds (the name is now a no-op), but the agent
  // file should be migrated.
  if (effectiveTools?.split(",").some((tool) => tool.trim() === "safe_bash")) {
    warnSafeBashDeprecatedOnce();
  }

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: piEffectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    alwaysOnExtensions: agentDefs?.alwaysOnExtensions ?? null,
    bashGuardMode: agentDefs?.bashGuardMode ?? null,
    cli: agentDefs?.cli ?? null,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: name });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envPrefix = buildSubagentLaunchEnvParts({
    resolvedAgentDir,
    name,
    agent: params.agent,
    grantSpawning,
    spawnable: agentDefs?.subagentAgents,
    autoExit: !!agentDefs?.autoExit,
    sessionFile: subagentSessionFile,
    id,
    activityFile,
    surface,
    backend: resolvedSpawnBackend(),
    bashGuardMode: agentDefs?.bashGuardMode ?? null,
  }).join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });
  if (kindOf(surface) === "background") {
    // Plan risk-1: announce the first headless spawn of this session. The log
    // path is known now: sendLongCommand registered it for bg: surfaces.
    const logPath = backgroundLogPathOf(surface);
    if (logPath) noteBackgroundSpawn(name, logPath);
  }

  const running: RunningSubagent = {
    id,
    name: name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  tailSucceeded = true;
  return running;
  } finally {
    if (!tailSucceeded) {
      // A late throw reached the tail's finally: the surface is created but
      // no watcher was ever started — close it best-effort so no live pane is
      // leaked. (On success the returned RunningSubagent carries the surface
      // and the watcher/abort machinery owns it instead.)
      try {
        await closeSurface(surface);
      } catch {
        // The pane may already be gone (herdr auto-closes a tab when its
        // last pane dies; the shell may have dropped it) — nothing to clean
        // up. A rejected background close (SIGTERM timeout) retains the
        // record fail-closed; the session_shutdown sweep retries it.
      }
    }
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  // Post-session guard: this is called from watchSubagent's poll onTick, which
  // can still tick (up to the 1s poll interval) while the session is tearing
  // down. A stale latestPi here would throw in the unhandled chain, the same
  // hazard as the completion delivery.
  if (sessionEnded) return;
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(askFile);
  } catch {}
  if (!payload?.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;
  // Plan risk-1: capture the log path BEFORE close() — for a background
  // surface the close deletes the registry record, after which the log path
  // is no longer recoverable. undefined for multiplexer surfaces.
  const backgroundLogPath = backgroundLogPathOf(surface);

  const close = async (opts?: { paneGone?: boolean }): Promise<void> => {
    // A multiplexer surface that pollForExit already confirmed GONE (paneGone
    // — e.g. the interrupt's pane close destroyed it) needs no second close
    // call: the pane is dead, the child is terminated, and re-closing would
    // only cost an extra CLI round-trip that fails with pane_not_found
    // (correctly classified as gone, but avoidable). Background surfaces are
    // EXCLUDED: their close() is the registry cleanup (surfaces.delete) plus a
    // best-effort process-group sweep for detached grandchildren, and it is
    // safe and cheap on an already-exited child — skipping it would retain
    // registry records. (paneGone is never set for bg: surfaces anyway: their
    // log tail never throws a pane error.)
    if (opts?.paneGone === true && !surface.startsWith("bg:")) {
      return;
    }
    try {
      await closeRunningSurface(running);
    } catch {
      // Best-effort: the pane/tab may already be gone (herdr auto-closes a tab
      // when its last pane dies; a user may have closed it). For background
      // surfaces a rejected close is a SIGTERM timeout — fail-closed retention
      // means a retry is possible; never crash the watcher on it.
    }
  };

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
        // An interrupted run is being torn down: don't deliver its pending
        // ask_question on top of the interruption notice.
        if (!running.userInterrupted) deliverPendingQuestion(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      // S3: a claude child's summary IS the assistant text (sentinel transcript
      // or pane screen). The synthetic fallback summaries below ("Claude Code
      // exited without output" / "exited with code N") are NOT assistant text,
      // so hasAssistantText is decided from the REAL output BEFORE they are
      // assigned (a check after the fact would read true for a no-output child
      // and the no-assistant-text fallback trigger could never fire for cli:
      // claude agents).
      const hasAssistantText = summary.trim().length > 0;

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      // paneGone: the surface was already destroyed during the poll (the
      // interrupt's close is the usual cause) — skip the redundant close
      // round-trip. See close() above.
      await close({ paneGone: result.paneGone });
      runningSubagents.delete(running.id);

      // S3: a claude child's summary IS the assistant text (sentinel transcript
      // or pane screen) — hasAssistantText was decided above, before the
      // synthetic fallback summaries could flip it to true.
      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        hasAssistantText,
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
        ...(backgroundLogPath ? { backgroundLogPath } : {}),
      };
    }

    // Pi subagent result extraction
    let summary: string;
    let hasAssistantText = false;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      // S3: whether the child produced ANY non-whitespace assistant text
      // anywhere in its session (derived from the same entries the summary is
      // extracted from). The synthetic fallback summaries below ("Subagent
      // error: …", "Sub-agent exited without output") are NOT assistant text.
      // Known limitation: fork-mode children have the parent's conversation
      // seeded into their session file, so this reads true for them and the
      // no-assistant-text fallback trigger is effectively disabled for fork
      // children — the errorMessage and non-zero-exit triggers still work, and
      // no bundled agent uses fork mode.
      hasAssistantText = sessionHasAssistantText(allEntries);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    await close({ paneGone: result.paneGone });
    runningSubagents.delete(running.id);

    // Interruption classification: the watcher only reports an interrupted run
    // when the surface was destroyed (paneGone — the interrupt's close is what
    // makes the pane disappear) AND the flag was set before the exit was read.
    // A child that completed normally before teardown leaves the terminal
    // sentinel behind (its shell outlives the sentinel), so pollForExit reports
    // reason "sentinel" with no paneGone — that is a normal completion, even
    // if the interrupt was requested a millisecond earlier.
    const interrupted = result.paneGone === true && running.userInterrupted === true;

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      hasAssistantText,
      ...(stats ? { stats } : {}),
      ...(backgroundLogPath ? { backgroundLogPath } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    };
  } catch (err: any) {
    await close();
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        interrupted: running.userInterrupted === true,
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
      interrupted: running.userInterrupted === true,
    };
  }
}

/** First non-empty line + total line count, for compact tool previews. */
function previewFirstLine(text: string): { firstLine: string; totalLines: number } {
  const lines = text.split("\n");
  return { firstLine: lines.find((l) => l.trim()) ?? "", totalLines: lines.length };
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    // A fresh session re-arms post-session delivery (pi can run multiple
    // sessions in one process; the previous one's shutdown set sessionEnded).
    sessionEnded = false;
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    // FIRST: arm the post-session guard. From here on the runtime may dispose
    // this session (print mode does so unconditionally after turn 1, invalidating
    // the ctx/pi) — every pending fire-and-forget delivery must no longer touch
    // latestCtx/latestPi. See `sessionEnded`.
    sessionEnded = true;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
    // D5: a killed parent must not orphan headless background children. The
    // watchers are already aborted (their polls throw → close path), but a
    // background record can outlive them (fail-closed retention after a
    // timeout, or a close that raced the shutdown) — sweep them here.
    // Fire-and-forget: the process is tearing down, and closeBackground
    // rejects (retaining the record) rather than throwing synchronously.
    void closeAllBackgroundSurfaces();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. The lone exception is a
        // top-level `fork: true` clone, which has no role and inherits the
        // caller's own already-trusted toolset. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const permittedAgents = SUBAGENT_ALLOWLIST
          ? [...SUBAGENT_ALLOWLIST]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // S3: resolve the primary run's effective model/thinking and the
        // agent's one-shot fallback NOW (at spawn time) so the watcher can
        // decide on a retry without re-reading the agent file or re-asking the
        // spawner's live model. `inherit` means the IMMEDIATE spawner's live
        // model (nested spawners inherit down the chain by design), not the
        // top-level session. (An invalid model-fallback value is refused at
        // launchSubagent, mirroring bash-guard-mode: fail-closed, before any
        // surface is created — discovery and the agent list stay healthy.)
        const spawnAgentDefs = loadAgentDefaults(params.agent);
        const parentModelDefaults = resolveParentModelDefaults(ctx as ExtensionContext);
        const primarySelection = resolvePrimaryModelSelection(params, spawnAgentDefs);
        const fallbackSelection = resolveFallbackModelAndThinking(params, spawnAgentDefs, parentModelDefaults, primarySelection);

        // A name collision is the more specific failure and is checked before
        // multiplexer availability so the refusal (and its pointer to
        // subagent_message) is deterministic regardless of environment.

        // Resolve the cosmetic pane label. Explicit names must be unique within
        // this spawner session — the name is the ONLY address for
        // subagent_message, so a duplicate would strand both subagents behind
        // an ambiguous handle (and silently overwrite the registry entry). An
        // explicit name that collides with a running, in-flight, or already
        // finished subagent is refused; the model is told to message it or
        // pick a different name instead. (Refusal over auto-suffixing: a
        // suffixed duplicate still races the first subagent on the same files.
        // No force escape hatch - a finished name means "continue it".)
        // Omitted names are auto-generated uniquely against the same set.
        let reservedName: string | null = null;
        let registryWarning: NameRegistryEntry | null = null;
        const nameRegistry = readNameRegistry(parentArtifactDir);
        const explicitName = params.name?.trim();
        if (explicitName) {
          const collision = nameCollisionForSpawn(explicitName, nameRegistry);
          if (collision.running) {
            const running = collision.running;
            const err =
              `Cannot spawn "${explicitName}": a subagent with that name is already running ` +
              `(id ${running.id}, started ${formatElapsed((Date.now() - running.startTime) / 1000)} ago). ` +
              `Use subagent_message({ name: "${explicitName}", message: "…" }) to continue it, ` +
              `or spawn under a different name.`;
            return {
              content: [{ type: "text" as const, text: err }],
              details: { error: "name collision", kind: "running", id: running.id, name: explicitName },
            };
          }
          if (collision.reserved) {
            const err =
              `Cannot spawn "${explicitName}": that name was just claimed by another spawn in this turn. ` +
              `Use subagent_message({ name: "${explicitName}", message: "…" }) to continue it, ` +
              `or spawn under a different name.`;
            return {
              content: [{ type: "text" as const, text: err }],
              details: { error: "name collision", kind: "in-flight", name: explicitName },
            };
          }
          if (collision.registryEntry) {
            const err =
              `Cannot spawn "${explicitName}": that name is already registered in this session ` +
              `(subagent finished earlier; session file ${collision.registryEntry.sessionFile}). ` +
              `Use subagent_message({ name: "${explicitName}", message: "…" }) to resume it, ` +
              `or spawn under a different name.`;
            return {
              content: [{ type: "text" as const, text: err }],
              details: { error: "name collision", kind: "finished", name: explicitName },
            };
          }
          params.name = explicitName;
          reservedName = explicitName;
          reservedNames.add(explicitName);
        } else {
          // Default the cosmetic pane label to the agent name, disambiguating
          // against running subagents, in-flight reservations, and every name
          // already in the registry — so names stay unique across the whole
          // session, running or finished. Reserve the chosen name
          // synchronously (before any await) so parallel spawns don't collide.
          params.name = uniqueRunningName(params.agent, new Set(Object.keys(nameRegistry)));
          reservedName = params.name;
          reservedNames.add(reservedName);
        }

        // Validate prerequisites, then launch. Both live in the same
        // try/finally as the launch so any early return (or a failed launch)
        // releases the name reservation - it must not outlive this spawn.
        // The prerequisite checks run after the name-collision refusal so that
        // guard stays deterministic even without a multiplexer.
        let running;
        try {
          if (!isMuxAvailable()) {
            return muxUnavailableResult();
          }

          if (!ctx.sessionManager.getSessionFile()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: no session file. Start pi with a persistent session to use subagents.",
                },
              ],
              details: { error: "no session file" },
            };
          }

          running = await launchSubagent(params, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        // A replacement here means the name was reclaimed between the check
        // above and this write - surface it instead of losing the old mapping.
        registryWarning = registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background. S3: a configured
        // model fallback gets ONE fresh retry from the original task when the
        // primary run fails (provider/agent error, non-zero exit, or no
        // assistant text); the failed child's artifacts stay on disk for
        // diagnosis. User cancellation NEVER falls back, and the retry's
        // result is final (one-shot: no second fallback).
        (watchSubagentForTest ?? watchSubagent)(running, watcherAbort.signal)
          .then(async (primaryResult) => {
            // Post-session guard: if the session shut down while we waited,
            // latestCtx/latestPi are stale (print mode disposes them) and both
            // updateWidget() and pi.sendMessage below would throw. The result
            // is unrecoverable anyway (no session left to steer it into) —
            // return silently instead of unhandled-rejecting and exiting 1.
            if (sessionEnded) return;
            // S2: a parent-cancelled run reports the concise interruption
            // notice instead of the normal completion result.
            if (finalizeInterruptedRun(pi, running, primaryResult)) return;

            let finalRunning = running;
            let result = primaryResult;

            // S3: one-shot model fallback. The retry reuses the SAME display
            // name. The failed first run is already gone from runningSubagents
            // (the first watcher removed it); its name-registry entry is NOT
            // deleted here — the retry's own registerName below overwrites it
            // in place (last-writer-wins, the same re-registration the
            // resumed-name path already accepts), which closes the window
            // below atomically. The first run's session file and loadout stay
            // on disk untouched, while its .exit sidecar is already consumed
            // by the watcher's poll loop, which deletes it right after
            // reading it.
            //
            // Registry window (by design): from the failed primary's watcher
            // finishing until the retry's registerName (~0.5-1s of launch
            // overhead) the registry keeps pointing at the FAILED PRIMARY's
            // session file. A subagent_message resume landing in that window
            // continues the failed primary — a finished run on a DIFFERENT
            // session file than the retry writes, so no concurrent-writer
            // corruption — and is refused as a same-name spawn by
            // nameCollisionForSpawn's registry branch. If the retry's launch
            // itself fails, the registry still holds the primary's entry (it
            // is never deleted) and the retry's orphaned surface is closed by
            // launchSubagent's late-throw cleanup (the `out.surfaceId` seam).
            const decision = fallbackDecision(primaryResult, fallbackSelection, primarySelection);
            if (decision.retry && decision.attribution) {
              const retryParams: typeof SubagentParams.static = {
                ...params,
                name: running.name,
                model: decision.attribution.to,
              };
              try {
                // S3: the retry FROZES its resolved model/thinking in its own
                // loadout (thinking `null` = no level, no agent-default
                // fallback), so later `subagent_message` resumes replay the
                // fallback selection — the same invariant as "resume replays
                // the original sandbox". `out` is launchSubagent's late-throw
                // seam: its internal cleanup closes a retry surface created
                // before a late throw, and `out.surfaceId` exposes the id to
                // the caller for observability/assertions.
                finalRunning = await launchSubagent(retryParams, ctx as ExtensionContext, {
                  thinking: decision.attribution.thinking ?? null,
                  out: { surfaceId: undefined },
                });
                finalRunning.abortController = watcherAbort;
                startWidgetRefresh();
                startStatusRefresh(pi);
                registerName(parentArtifactDir, finalRunning.name, {
                  sessionFile: finalRunning.sessionFile,
                  sessionId: getSessionId(finalRunning.sessionFile),
                });
                result = await watchSubagent(finalRunning, watcherAbort.signal);
                // The retry's result is final — attribution only, never a
                // second retry (shouldRetryWithFallback is not re-applied).
                result.fallback = decision.attribution;
              } catch (error: any) {
                // S3: the launch itself failed AFTER its surface was created
                // (e.g. the pane died in the shell-ready window and
                // sendLongCommand threw). launchSubagent's late-throw cleanup
                // already closed that surface (the `out` seam), so nothing is
                // leaked here; the registry entry for the name still points
                // at the failed primary (never deleted), so it stays
                // resumable. NO retry ever ran — the message is therefore
                // launch-failure-specific (not "auto-retry exhausted"), names
                // the models, and keeps the fallback attribution on the
                // result so the orchestrator sees what was attempted and can
                // resume the failed primary by name.
                result = {
                  ...primaryResult,
                  exitCode: 1,
                  errorMessage:
                    `model fallback: ${decision.attribution.from ? `\`${decision.attribution.from}\` → ` : ""}\`${decision.attribution.to}\` ` +
                    `launch failed: ${error?.message ?? String(error)} ` +
                    `(the failed primary run stays in artifacts; resume it via subagent_message)`,
                  launchFailed: true,
                  fallback: decision.attribution,
                };
              }
              // S2: a user cancellation that landed while the RETRY was running
              // reports the concise interruption notice (result.interrupted is
              // set by the retry's watcher) instead of misreporting it as a
              // provider failure — the retry's result is final, exactly like
              // the primary's.
              if (finalizeInterruptedRun(pi, finalRunning, result)) return;
            }

            // The fallback retry above has intermediate awaits — the session
            // may have shut down (invalidating the ctx/pi) while the retry ran.
            // Re-check before the final widget render + steer delivery.
            if (sessionEnded) return;

            updateWidget(); // reflect removal from Map immediately

            // Update registry with resolved sessionId if it was previously null
            if (result.sessionId) {
              registerName(parentArtifactDir, finalRunning.name, {
                sessionFile: finalRunning.sessionFile,
                sessionId: result.sessionId,
              });
            }

            // S3: note a skipped same-model+thinking retry only when the
            // fallback trigger actually fired (skippedSameSelection is set only
            // in that case) — the trigger can be no-assistant-text with exit
            // code 0, so gating on exitCode !== 0 would drop the note.
            const presentation = resolveResultPresentation(
              decision.skippedSameSelection && shouldRetryWithFallback(primaryResult).retry
                ? {
                    ...result,
                    summary:
                      `model fallback skipped: the fallback resolves to the same model ` +
                      `and thinking as the failed primary run.\n\n` + result.summary,
                  }
                : result,
              finalRunning.name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: finalRunning.name,
                  task: finalRunning.task,
                  agent: finalRunning.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.launchFailed ? { launchFailed: true } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                  ...(result.fallback ? { modelFallback: result.fallback } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            // Post-session guard (see the .then above): the session may have
            // shut down while the watcher ran — delivering now would touch a
            // stale ctx/pi and throw in the unhandled chain.
            if (sessionEnded) return;
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.` +
                (registryWarning
                  ? `

Warning: the name "${params.name}" already pointed at session ${registryWarning.sessionFile} in the registry; the mapping now points at this spawn. The earlier subagent's session is no longer addressable by this name.`
                  : ""),
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme, context: any = {}) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        const header =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Full view when the row is expanded AND no longer partial: live
        // completion sets argsComplete, but the restore path never calls
        // setArgsComplete(), so a restored row (argsComplete false, isPartial
        // false) must expand too; isPartial true (streaming / in-flight) keeps
        // the preview form; absent context (two-arg callers, HTML export) →
        // collapsed. renderResult below is just the status line (— started).
        const expanded =
          context?.expanded === true &&
          (context?.argsComplete === true || context?.isPartial !== true);

        let text: string;
        if (expanded && task) {
          // Expanded: the full task, uncut, newlines preserved, default colour.
          // The TUI box wraps long lines at the content width, so pass it as one
          // Text without pre-slicing (mirrors the built-in read expanded view).
          text = header + "\n" + task;
        } else {
          // Collapsed (default, or args still streaming): one-line preview.
          text = header;
          if (task) {
            const { firstLine, totalLines } = previewFirstLine(task);
            const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
            if (preview) {
              text += "\n" + theme.fg("toolOutput", preview);
            }
            if (totalLines > 1) {
              text += theme.fg("muted", ` (${totalLines} lines)`);
            }
            text += "\n" + theme.fg("muted", keyHint("app.tools.expand", "to expand"));
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Cancel a running sub-agent by exact `id` or `name` (exactly one of the two). " +
        "This is cancellation, not a pause: it sends Escape to stop the in-flight turn, terminates the child process, and closes its pane. " +
        "The watcher then steers ONE concise interruption notice (marked interrupted) instead of a result — no result will follow. " +
        "Use it for a runaway, obsolete, or superseded sub-agent. " +
        "Interrupting an unknown, already-finished, or ambiguous target returns a clear error instead.",
      promptSnippet:
        "Cancel a running sub-agent by exact id or name. Terminates the child process and closes its pane; " +
        "the watcher steers a concise interruption notice instead of a result.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id (the id returned by the spawn acknowledgement)." })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name." })),
      }),

      async execute(_toolCallId, params): Promise<any> {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const partialArgs = args as { id?: unknown; name?: unknown };
        const target =
          typeof partialArgs.id === "string" && partialArgs.id
            ? partialArgs.id
            : typeof partialArgs.name === "string" && partialArgs.name
              ? partialArgs.name
              : "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — interrupt"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? details?.id ?? "subagent";
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("warning", "!") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }
        if (details?.status === "interrupt_already_requested") {
          return new Text(
            theme.fg("warning", "!") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — already interrupted"),
            0,
            0,
          );
        }

        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "`name` and `message` are both required. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
        "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme, context: any = {}) {
        const partialArgs = args as Record<string, unknown>;
        const target = typeof partialArgs.name === "string" && partialArgs.name
          ? partialArgs.name
          : "(unknown)";
        const message = typeof partialArgs.message === "string" ? partialArgs.message : "";
        const header = "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message");

        // Same expansion rule as the `subagent` spawn block: full message when
        // the row is expanded AND no longer partial — restored rows (argsComplete
        // false, isPartial false) expand too, since the restore path never calls
        // setArgsComplete(); isPartial true (streaming / in-flight) keeps the
        // preview form. renderResult below stays the status line
        // (— message delivered / — resumed).
        const expanded =
          context?.expanded === true &&
          (context?.argsComplete === true || context?.isPartial !== true);

        let text: string;
        if (expanded && message) {
          // Expanded: the full message, uncut, newlines preserved, default
          // colour. The TUI box wraps long lines at the content width.
          text = header + "\n" + message;
        } else {
          // Collapsed (default, or args still streaming): one-line preview.
          text = header;
          if (message) {
            const { firstLine, totalLines } = previewFirstLine(message);
            const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
            if (preview) {
              text += "\n" + theme.fg("toolOutput", preview);
            }
            if (totalLines > 1) {
              text += theme.fg("muted", ` (${totalLines} lines)`);
            }
            text += "\n" + theme.fg("muted", keyHint("app.tools.expand", "to expand"));
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        // resolveRunningByName (not a raw first-match find) so that if two
        // subagents ever share a name the ambiguity is reported with both ids
        // instead of silently steering whichever was registered first.
        const runningResolution = resolveRunningByName(requestedName);
        if (!("error" in runningResolution)) {
          return handleSubagentSteer({ name: requestedName, message: params.message });
        }
        // Two running subagents share the name: refuse to guess which one was
        // meant, and do NOT fall through to the resume path (the registry can
        // only hold one session per name). Report both ids instead.
        if (runningResolution.ambiguous) {
          return {
            content: [{ type: "text" as const, text: runningResolution.error }],
            details: { error: runningResolution.error, status: "ambiguous" },
          };
        }
        // No running subagent with this name: resolve it via the registry and
        // resume its session with the message as the follow-up.

        // ── Resume a finished session by name ──
        const message = params.message;
        const name = requestedName; // identity preservation: the resumed run reclaims its name
        const { autoExit, interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        // Resolve the name to its session file via this session's registry.
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
        if (!entry) {
          const known = Object.keys(readNameRegistry(parentArtifactDir));
          const err =
            `No subagent named "${requestedName}" in this session. ` +
            (known.length > 0
              ? `Known subagents: ${known.join(", ")}.`
              : "No subagents have been spawned in this session yet.");
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const sessionPath = entry.sessionFile;
        if (!sessionPath || !existsSync(sessionPath)) {
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Guard: never resume a session that is still running — two processes
        // mutating the same .jsonl corrupts it. Steer it by name instead.
        for (const r of runningSubagents.values()) {
          if (resolve(r.sessionFile) === resolve(sessionPath)) {
            const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
            return handleSubagentSteer({ name: r.name, message: params.message });
          }
        }

        // Reconstruct the sandbox from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // S4 (resume) + mode validation: a guard-mode child must still be
        // guardable when it is relaunched. Re-run the same fail-closed check
        // against the SNAPSHOT (not the current agent file) - the snapshot wins,
        // the same rule as the mode env itself (PI_BASH_GUARD_MODE is replayed
        // from loadout.bashGuardMode below). A read-only child spawned while
        // bash-guard was in alwaysOnExtensions, then resumed after the guard
        // was removed from config, would otherwise relaunch with the read-only
        // toolset + PI_BASH_GUARD_MODE but NO `-e bash-guard` (applySandboxToParts
        // re-resolves the snapshot's always-on extensions and the guard is gone)
        // -> bare bash under a read-only label. Refuse rather than let it start
        // unguarded. `off` and null/absent modes skip the check entirely.
        //
        // A missing `cli` on a pre-field snapshot is treated as the pi CLI:
        // spawn refuses a guard-mode child on `cli: claude`, so the only
        // guard-mode children that ever existed were pi children. (The claude
        // branch below is dead code for real snapshots; kept for consistency.)
        const resumeGuardMode = loadout.bashGuardMode ?? null;
        if (resumeGuardMode != null) {
          // DEFENSE-IN-DEPTH (matches spawn, not a new security boundary): a
          // hand-edited .loadout.json could carry an invalid mode ("ro", etc.).
          // Validate before emitting. bash-guard itself fails closed to floor
          // on an invalid env var, so the child would still be guarded - but we
          // refuse to emit a value we would refuse at spawn, and name the loadout
          // file so the corruption is locatable.
          const invalidMode = validateBashGuardMode(
            loadout.agent ?? name,
            resumeGuardMode,
            loadoutSidecarPath(sessionPath),
          );
          if (invalidMode) {
            const err =
              `Cannot safely resume "${requestedName}": ${invalidMode}. ` +
              `The sandbox snapshot (${loadoutSidecarPath(sessionPath)}) is corrupted or ` +
              `hand-edited. Re-run the task as a fresh subagent instead.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: err } };
          }
          // Re-run the S4 fail-closed check against the snapshot's always-on set.
          const guardErr = assertBashGuardLoaded(
            loadout.agent ?? name,
            resumeGuardMode,
            loadout.cli ?? undefined,
            loadout.alwaysOnExtensions ?? [],
          );
          if (guardErr) {
            const err =
              `Cannot safely resume "${requestedName}": ${guardErr}. ` +
              `Resuming would relaunch the child in bash-guard-mode '${resumeGuardMode}' ` +
              `without the guard loaded. Re-run the task as a fresh subagent instead.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: err } };
          }
        }

        const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

        // Record entry count before resuming so we can extract new messages.
        // Count lines cheaply (no per-line JSON.parse) so resuming a large
        // transcript doesn't block the UI.
        const entryCountBefore = countSessionEntryLines(sessionPath);

        const surface = await createSubagentSurface(name, loadout.cwd, ctx.cwd);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command (same shared head as launch — D3 --print
        // included; the surface is re-resolved at resume time, so a resumed
        // background child gets --print exactly like its original launch).
        const parts = buildPiLaunchParts(sessionPath, surface);

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Replay the model, identity, and default-deny tool/extension sandbox.
        applySandboxToParts(parts, loadout, { artifactDir, name });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — replay the snapshot's config dir + spawn whitelist
        // so the resumed process resolves the same agents/extensions and keeps
        // the same nested-spawn restriction it originally ran with.
        const resumeEnvPrefix = buildSubagentResumeEnvParts({
          agentDir: loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
          name,
          sessionPath,
          id,
          activityFile,
          agent: loadout.agent,
          spawnable: loadout.spawnable,
          autoExit,
          backend: resolvedSpawnBackend(),
          bashGuardMode: loadout.bashGuardMode ?? null,
        }).join(" ") + " ";

        // Resume in the subagent's original cwd so its tools (bash, edits)
        // operate where they did before.
        const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

        const command = `${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: message,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        if (kindOf(surface) === "background") {
          // Plan risk-1: announce the first headless spawn of this session.
          const logPath = backgroundLogPathOf(surface);
          if (logPath) noteBackgroundSpawn(name, logPath);
        }
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            // Post-session guard: a resumed run finishing after the session
            // shut down would deliver into a stale ctx/pi (print mode) and
            // throw in the unhandled chain — return silently instead.
            if (sessionEnded) return;
            updateWidget();

            // A parent-cancelled resumed run reports the concise interruption
            // notice instead of the normal completion result.
            if (finalizeInterruptedRun(pi, running, { ...result, sessionId: resumedSessionId })) return;

            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: message,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: sessionPath,
                  sessionId: resumedSessionId,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            // Post-session guard (see the .then above): skip delivery into a
            // stale ctx/pi after session shutdown.
            if (sessionEnded) return;
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    const name = details.name ?? "subagent";
    const exitCode = details.exitCode ?? 0;
    const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
    const interrupted = details.interrupted === true;
    const interruptionActor = typeof details?.interruption?.actor === "string" ? details.interruption.actor : null;
    const failed = !interrupted && (exitCode !== 0 || !!errorMessage);
    const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
    const bgFn = interrupted
      ? (text: string) => theme.bg("customMessageBg", text)
      : failed
        ? (text: string) => theme.bg("toolErrorBg", text)
        : (text: string) => theme.bg("toolSuccessBg", text);

    const buildResultLines = (width: number, expanded: boolean, activeTheme: any): string[] => {
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = interrupted
          ? activeTheme.fg("warning", "◼")
          : failed
            ? activeTheme.fg("error", "✗")
            : activeTheme.fg("success", "✓");
        const agentTag = details.agent ? activeTheme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? activeTheme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${activeTheme.fg("toolTitle", activeTheme.bold(name))}${agentTag}${modelTag} ${activeTheme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        // Interrupted: name the actor from the details (never from the content).
        let header: string;
        if (interrupted) {
          header = `${titleSegment}${activeTheme.fg("warning", `interrupted by ${interruptionActor ?? "main_agent"}`)} ${activeTheme.fg("dim", `· ${elapsed}`)}`;
        } else if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${activeTheme.fg("error", reason)} ${activeTheme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${activeTheme.fg("dim", toolPart)}`;
        }

        // S3: one-shot model fallback — attribute the retry so the
        // orchestrator sees which model produced the result (follows the
        // interrupted-state rendering style: a colored reason line in the
        // header area, dim attribution in the expanded footer).
        const modelFallback = details.modelFallback as
          | { from?: string; to: string; reason: string; failedSessionFile?: string }
          | undefined;
        const fallbackLine = modelFallback
          ? activeTheme.fg(
              "warning",
              `model fallback: ${modelFallback.from ? `${modelFallback.from} → ` : ""}${modelFallback.to}`,
            )
          : null;

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => activeTheme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? activeTheme.fg("error", ctxStr) : pct > 70 ? activeTheme.fg("warning", ctxStr) : activeTheme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(activeTheme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (fallbackLine) contentLines.push(fallbackLine);
        if (usageLine) contentLines.push(usageLine);

        if (expanded) {
          // Full view: complete summary + session info.
          // Summary lines are passed through intact: the Text component wraps
          // them at the box's content width (width - 6), so long lines wrap
          // instead of being truncated. Pre-slicing here would cut them first.
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line);
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (modelFallback) {
              contentLines.push(
                activeTheme.fg(
                  "dim",
                  `Failed primary: ${modelFallback.failedSessionFile ?? "(session retained in artifacts)"} (${modelFallback.reason})`,
                ),
              );
            }
            if (details.name) {
              contentLines.push(
                activeTheme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(activeTheme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint. Preview lines are also passed
          // through unwrapped (Text wraps at the content width) so long lines
          // wrap instead of being cut.
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(activeTheme.fg("dim", line));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(activeTheme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(activeTheme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        return contentLines;
    };

    // Clickable wrapper: pi's CustomMessageComponent hosts this component without
    // its own mouse handling, so the renderer must supply its own click region
    // for click-to-expand (Ctrl+O works regardless via setExpanded).
    return createExpandableMessageComponent(message, options, theme, buildResultLines, bgFn);
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    const buildStatusLines = (width: number, expanded: boolean, activeTheme: any): string[] => {
      const lineWidth = Math.max(0, width - 6);
      const contentLines = [
        `${activeTheme.fg("accent", "•")} ${activeTheme.fg("toolTitle", activeTheme.bold("Subagent status"))}`,
        ...lines.map((line: string) => activeTheme.fg("dim", truncateToWidth(line, lineWidth))),
      ];

      if (overflow > 0) {
        contentLines.push(activeTheme.fg("muted", `+${overflow} more running.`));
      }
      if (!expanded) {
        contentLines.push(activeTheme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      return contentLines;
    };

    return createExpandableMessageComponent(message, options, theme, buildStatusLines, (text: string) => theme.bg("customMessageBg", text));
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    const buildQuestionLines = (width: number, expanded: boolean, activeTheme: any): string[] => {
      const name = details.name ?? "subagent";
      const agentTag = details.agent ? activeTheme.fg("dim", ` (${details.agent})`) : "";

      const icon = activeTheme.fg("accent", "?");
      const header = `${icon} ${activeTheme.fg("toolTitle", activeTheme.bold(name))}${agentTag} ${activeTheme.fg("dim", "— asks a question")}`;

      const contentLines = [header];

      if (expanded) {
        contentLines.push("");
        contentLines.push(details.question ?? "");
        contentLines.push("");
        contentLines.push(
          activeTheme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
        );
      } else {
        const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
        contentLines.push(activeTheme.fg("dim", preview));
        contentLines.push(activeTheme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      return contentLines;
    };

    return createExpandableMessageComponent(message, options, theme, buildQuestionLines, (text: string) => theme.bg("toolSuccessBg", text));
  });

}
// test
