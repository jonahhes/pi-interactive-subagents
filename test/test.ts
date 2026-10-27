import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
// Must be imported before the subagents module so the subagent-identity env
// vars are cleared before index.ts captures PI_SUBAGENT_ALLOWED at load time.
// eslint-disable-next-line import/first
import "./_env-hermetic.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
  deleteName,
  sessionHasAssistantText,
} from "../pi-extension/subagents/session.ts";

import { shellEscape } from "../pi-extension/subagents/tmux.ts";
import {
  balanceTree,
  balanceLeafCount,
  chooseSplitDirection,
  isAgentNotFound,
  flattenForRawPane,
  isLayoutEven,
  isHerdrAvailable,
  herdrSocketPath,
  splitDirectionSetting,
  __herdrCliForTest__,
  type HerdrLayoutNode,
} from "../pi-extension/subagents/herdr.ts";
import {
  detectMux,
  muxKind,
  isMuxAvailable,
  __setBackendForTest__,
  __resetActiveBackendCacheForTest__,
  pollForExit,
  isSurfaceGoneError,
  __pollForExitTest__ as surfacePollForExitTest,
  resolveSurfaceBackend,
  activeBackend,
  setConfigBackendPreference,
  kindOf,
  createSurface,
  createSurfaceTab,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  sendMessage,
  labelSurface,
  readScreen,
  closeSurface,
  backgroundLogPathOf,
  tmuxBackend,
  herdrBackend,
  backgroundBackend,
  closeAllBackgroundSurfaces,
} from "../pi-extension/subagents/surface.ts";
import {
  createBackgroundSurface,
  launchBackground,
  interruptBackground,
  closeBackground,
  hasBackgroundSurface,
  allBackgroundSurfaces,
  backgroundExitCode,
} from "../pi-extension/subagents/background.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadSubagentConfig,
  parseStatusConfig,
  parseSpawnConfig,
  parseAlwaysOnExtensionsConfig,
  resolveSpawnSurface,
  resolveSpawnBackend,
  type StatusSnapshot,
  type SubagentStatusState,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
  type SubagentWaitingReason,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
  resolveWaitingReason,
  isBackgroundChild,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/tmux.ts";

// --- Helpers ---

function hasCommandLocally(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,web_search,subagent,ask_question",
      model: "litellm/coding-reasoning",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      alwaysOnExtensions: null,
      bashGuardMode: null,
      cli: null,
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadSubagentConfig(examplePath);

    assert.deepEqual(config, {
      status: { enabled: true, lineLimit: 4 },
      spawn: { surface: "tabs", backend: "auto" },
      alwaysOnExtensions: { paths: ["~/.pi/agent/extensions/bash-guard"], errors: [] },
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadSubagentConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        status: { enabled: true, lineLimit: 4 },
        spawn: { surface: "panes" },
        alwaysOnExtensions: { paths: [], errors: [] },
      });
    });
  });

  it("parses a tabs spawn surface from config", () => {
    const config = parseSpawnConfig({
      status: { enabled: true },
      spawn: { surface: "tabs" },
    });
    assert.deepEqual(config, { surface: "tabs" });

    // Both values accepted; the section is optional.
    assert.deepEqual(parseSpawnConfig({ status: { enabled: true }, spawn: { surface: "panes" } }), {
      surface: "panes",
    });
    assert.deepEqual(parseSpawnConfig({ status: { enabled: true } }), { surface: "panes" });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
    assert.throws(
      () => parseSpawnConfig({ spawn: { surface: "windows" } }),
      /spawn\.surface must be "panes" or "tabs"/,
    );
    assert.throws(
      () => parseSpawnConfig({ spawn: { surface: "tabs", layout: "even" } }),
      /spawn has unsupported key\(s\): layout/,
    );
  });

  it("parses alwaysOnExtensions: absent section and explicit empty list both mean none", () => {
    assert.deepEqual(parseAlwaysOnExtensionsConfig({ status: { enabled: true } }), {
      paths: [],
      errors: [],
    });
    assert.deepEqual(
      parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [] } }),
      { paths: [], errors: [] },
    );
  });

  it("parses absolute alwaysOnExtensions paths (trimmed) and warns about missing ones", () => {
    withTempDir((dir) => {
      const extDir = join(dir, "bash-guard");
      mkdirSync(extDir, { recursive: true });
      // A loadable extension directory: package.json with a pi.extensions manifest.
      writeFileSync(
        join(extDir, "package.json"),
        JSON.stringify({ name: "guard", type: "module", pi: { extensions: ["./index.ts"] } }),
      );
      writeFileSync(join(extDir, "index.ts"), "export default (pi) => {};\n");
      const extFile = join(dir, "guard.ts");
      writeFileSync(extFile, "export default () => {};\n");

      const { paths, errors } = parseAlwaysOnExtensionsConfig({
        alwaysOnExtensions: {
          paths: [`${extDir}  `, extFile, join(dir, "missing"), join(dir, "bash-guard", "policy.ts")],
        },
      });
      assert.deepEqual(paths, [extDir, extFile]);
      assert.equal(errors.length, 2);
      assert.match(errors[0], /alwaysOnExtensions\.paths\[2\] .*does not exist/);
      assert.match(errors[1], /alwaysOnExtensions\.paths\[3\] .*does not exist/);
    });
  });

  it("alwaysOnExtensions warns about directories that are not loadable by pi", () => {
    withTempDir((dir) => {
      const plainDir = join(dir, "plain-dir");
      mkdirSync(plainDir, { recursive: true });
      const bareFileDir = join(dir, "files-only");
      mkdirSync(bareFileDir, { recursive: true });
      writeFileSync(join(bareFileDir, "helper.ts"), "export const x = 1;\n");

      // A directory with neither a pi manifest nor an index file: pi's loader
      // would hand it to jiti as a directory import (silent failure in the
      // child), so flag it here.
      const a = parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [plainDir] } });
      assert.deepEqual(a.paths, []);
      assert.equal(a.errors.length, 1);
      assert.match(a.errors[0], /not a loadable extension path/);

      // Files in the directory don't count: the manifest or an index is required.
      const b = parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [bareFileDir] } });
      assert.deepEqual(b.paths, []);
      assert.equal(b.errors.length, 1);

      // A directory with an index.ts is loadable.
      const indexedDir = join(dir, "indexed");
      mkdirSync(indexedDir, { recursive: true });
      writeFileSync(join(indexedDir, "index.ts"), "export default () => {};\n");
      const c = parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [indexedDir] } });
      assert.deepEqual(c.paths, [indexedDir]);
      assert.deepEqual(c.errors, []);
    });
  });

  it("keeps existing ~/ alwaysOnExtensions paths and expands them against $HOME", () => {
    withTempDir((dir) => {
      const fakeHome = join(dir, "home");
      const guardDir = join(fakeHome, "pi", "agent", "extensions", "bash-guard");
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(join(guardDir, "index.ts"), "export default (pi) => {};\n");
      const previousHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const { paths, errors } = parseAlwaysOnExtensionsConfig({
          alwaysOnExtensions: {
            paths: ["~/pi/agent/extensions/bash-guard"],
          },
        });
        assert.deepEqual(paths, ["~/pi/agent/extensions/bash-guard"]);
        assert.deepEqual(errors, []);

        // A ~/ entry whose target does not exist warns and is dropped
        // (children run as the same user, so the parent's home is the right check).
        const missing = parseAlwaysOnExtensionsConfig({
          alwaysOnExtensions: {
            paths: ["~/definitely-not-here-12345/bash-guard"],
          },
        });
        assert.deepEqual(missing.paths, []);
        assert.equal(missing.errors.length, 1);
        assert.match(missing.errors[0], /does not exist/);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("alwaysOnExtensions rejects relative paths and invalid entries", () => {
    const relativePathError = new RegExp("must be an absolute or ~/ path");
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: ["bash-guard"] } }),
      relativePathError,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: ["relative/dir"] } }),
      relativePathError,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [""] } }),
      /must be a non-empty string/,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: [42] } }),
      /must be a non-empty string/,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: { a: 1 } } }),
      /alwaysOnExtensions\.paths must be an array/,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: ["/x"], enabled: true } }),
      /alwaysOnExtensions has unsupported key\(s\): enabled/,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: ["-~/.pi/agent/extensions/bash-guard"] } }),
      /exclusions only apply per-agent/,
    );
    assert.throws(
      () => parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: "bash-guard" }),
      /alwaysOnExtensions must be an object/,
    );
  });

  it("alwaysOnExtensions: a bare ~ is always a warning, never a loadable path", () => {
    const bare = parseAlwaysOnExtensionsConfig({ alwaysOnExtensions: { paths: ["~"] } });
    assert.deepEqual(bare.paths, []);
    assert.equal(bare.errors.length, 1);
    assert.match(bare.errors[0], /is not a loadable extension path/);
  });

  it("resolves the spawn surface with the env override winning over config", () => {
    assert.equal(resolveSpawnSurface(undefined, "tabs"), "tabs");
    assert.equal(resolveSpawnSurface("", "tabs"), "tabs");
    assert.equal(resolveSpawnSurface("  ", "panes"), "panes");
    assert.equal(resolveSpawnSurface("panes", "tabs"), "panes");
    assert.equal(resolveSpawnSurface("TABS", "panes"), "tabs");
    assert.equal(resolveSpawnSurface(" Tabs ", "panes"), "tabs");
    assert.throws(
      () => resolveSpawnSurface("windows", "panes"),
      /Invalid PI_SUBAGENT_SPAWN_SURFACE value/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadSubagentConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadSubagentConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadSubagentConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });

  it("observeStatus carries waitingReason; a missing snapshot keeps the last value", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    assert.equal(state.waitingReason, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      waitingReason: "own_children",
    }, 10_000);
    assert.equal(state.waitingReason, "own_children");

    // A missing snapshot leaves the last value in place (mirrors waitingSinceMs).
    state = observeStatus(state, { snapshot: "missing" }, 11_000);
    assert.equal(state.waitingReason, "own_children");

    // An explicit null clears it again.
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 12_000,
      sequence: 2,
      phase: "waiting",
      waitingSince: 12_000,
    }, 12_000);
    assert.equal(state.waitingReason, null);
  });

  it("classifyStatus exposes waitingReason on every snapshot", () => {
    const waitingState = observeStatus(createStatusState({ source: "pi", startTimeMs: 0 }), {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      waitingReason: "own_children",
    }, 10_000);
    const waitingSnapshot = classifyStatus(waitingState, 240_000);
    assert.equal(waitingSnapshot.kind, "waiting");
    assert.equal(waitingSnapshot.waitingReason, "own_children");

    // Unannotated waiting and the claude fallback also carry the field (null).
    const unannotated = classifyStatus(
      observeStatus(createStatusState({ source: "pi", startTimeMs: 0 }), {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
      }, 10_000),
      240_000,
    );
    assert.equal(unannotated.waitingReason, null);
    assert.equal(classifyStatus(createStatusState({ source: "claude", startTimeMs: 0 }), 10_000).waitingReason, null);
  });

  it("forceStatusAfterInterrupt clears a stale waitingReason (statusLabel precedence wins)", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 5_000,
      waitingReason: "own_children",
    }, 5_000);
    assert.equal(classifyStatus(state, now).waitingReason, "own_children");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);
    assert.equal(forced.waitingReason, null);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingReason, null);
    assert.equal(snapshot.activityLabel, "interrupted");
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("bundled scout/researcher/worker/reviewer/adversarial-review all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker", "reviewer", "adversarial-review"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("worker is granted the spawning toolset restricted to its declared agents", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    // Assert the core two are declared spawnable (not an exact list): a
    // global/project `worker.md` can shadow the bundled one and legitimately
    // add agents (e.g. `investigator`). The invariant is that the declared
    // spawnables include the core two.
    assert.ok(Array.isArray(worker.subagentAgents), "worker should declare subagent_agents");
    for (const a of ["scout", "researcher"]) {
      assert.ok(worker.subagentAgents!.includes(a), `expected ${a} in worker spawnables`);
    }

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("loads always-on-extensions from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "always-on-test-agent",
        [
          "name: always-on-test-agent",
          "tools: read,bash",
          "always-on-extensions: ~/pi/agent/extensions/bash-guard,/abs/path/to/guard.ts,-~/pi/agent/extensions/bash-guard",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("always-on-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.deepEqual(loaded.alwaysOnExtensions, [
        "~/pi/agent/extensions/bash-guard",
        "/abs/path/to/guard.ts",
        "-~/pi/agent/extensions/bash-guard",
      ]);
    });
  });

  it("resolveAlwaysOnExtensionPaths expands ~/ entries against this process's home", () => {
    const previousHome = process.env.HOME;
    withTempDir((d) => {
      const fakeHome = join(d, "home");
      const guardDir = join(fakeHome, "pi", "agent", "extensions", "bash-guard");
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(join(guardDir, "index.ts"), "export default (pi) => {};\n");
      process.env.HOME = fakeHome;
      testApi.__setAlwaysOnExtensionsConfigForTest(["~/pi/agent/extensions/bash-guard"]);
      try {
        // The child receives an absolute path: pi's own ~ expansion and the
        // child's cwd would otherwise be ambiguous.
        assert.deepEqual(testApi.resolveAlwaysOnExtensionPaths(), [guardDir]);
      } finally {
        testApi.__setAlwaysOnExtensionsConfigForTest(null);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("frontmatter exclusions (leading -) subtract global always-on extensions per agent", () => {
    const previousHome = process.env.HOME;
    const origWarn = console.warn;
    let warned: string[] = [];
    console.warn = (msg: unknown) => { warned.push(String(msg)); };
    withTempDir((d) => {
      const fakeHome = join(d, "home");
      const guardDir = join(fakeHome, "pi", "agent", "extensions", "bash-guard");
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(join(guardDir, "index.ts"), "export default (pi) => {};\n");
      process.env.HOME = fakeHome;
      testApi.__setAlwaysOnExtensionsConfigForTest(["~/pi/agent/extensions/bash-guard"]);
      try {
        // ~/ exclusion form matches the ~/ global form (canonical paths).
        assert.deepEqual(testApi.resolveAlwaysOnExtensionPaths(["-~/pi/agent/extensions/bash-guard"]), []);
        // Absolute exclusion form matches the same global entry too.
        assert.deepEqual(testApi.resolveAlwaysOnExtensionPaths([`-${guardDir}`]), []);
        // Exclusion via a symlink to the entry also matches (realpath).
        const link = join(d, "link-to-guard");
        symlinkSync(guardDir, link);
        assert.deepEqual(testApi.resolveAlwaysOnExtensionPaths([`-${link}`]), []);

        // An exclusion that matches nothing warns and keeps everything.
        warned = [];
        assert.deepEqual(testApi.resolveAlwaysOnExtensionPaths(["-~/pi/agent/extensions/not-configured"]), [guardDir]);
        assert.equal(warned.length, 1);
        assert.match(warned[0], /exclusion matched nothing/);

        // A relative exclusion is a configuration error.
        assert.throws(
          () => testApi.resolveAlwaysOnExtensionPaths(["-bash-guard"]),
          new RegExp("must be an absolute or ~/ path"),
        );
      } finally {
        testApi.__setAlwaysOnExtensionsConfigForTest(null);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    console.warn = origWarn;
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", () => {
    assert.equal(testApi.getToolExtensionPath("read"), undefined);
    assert.equal(testApi.getToolExtensionPath("bash"), undefined);
    // web_search is extension-backed, but WHICH extension provides it is
    // host-specific (the canonical web-search extension, a ddgs-based one, or
    // none installed). So don't pin a specific file: assert the resolver's
    // contract instead - it reports web_search as unbacked (undefined) or
    // points at a file that actually exists, never a dangling path.
    const webSearchPath = testApi.getToolExtensionPath("web_search");
    assert.ok(
      webSearchPath === undefined || existsSync(webSearchPath),
      `web_search must resolve to undefined or an existing file, got: ${webSearchPath}`,
    );
    // safe_bash was removed (S7 Phase 2): it no longer maps to any extension file.
    assert.equal(testApi.getToolExtensionPath("safe_bash"), undefined);
    // Spawning tools are registered by this extension itself.
    assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
    // S4: grantable pi builtin extensions map to the CLI-resolved `builtin:`
    // spec (there is no file on disk — pi >=1.0.0's `-e` accepts the spec).
    assert.equal(testApi.getToolExtensionPath("codemode"), "builtin:codemode");
    assert.equal(testApi.getToolExtensionPath("tool_search"), "builtin:tool-search");
  });

  it("S4: applySandboxToParts passes builtin: extension specs through verbatim (no existsSync gate)", () => {
    withTempDir((d) => {
      // Hermetic: pin the always-on set to empty so only the tool-backed
      // extensions can contribute `-e` entries.
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const parts: string[] = [];
        testApi.applySandboxToParts(
          parts,
          {
            agent: "scout",
            // codemode is in the allowlist; no builtin:codemode file exists
            // on disk anywhere, so emitting the spec PROVES the existsSync
            // gate was skipped for builtin: paths.
            toolAllowlist: "read,grep,find,ls,bash,codemode,ask_question",
            model: null,
            thinking: null,
            systemPromptMode: null,
            identity: null,
            spawnable: null,
            alwaysOnExtensions: null,
            autoExit: true,
            cwd: null,
            agentDir: null,
          },
          { artifactDir: d, name: "scout" },
        );
        const eValues = parts
          .map((p, i) => (p === "-e" ? parts[i + 1] : null))
          .filter((p): p is string => p !== null);
        // shellEscape wraps in single quotes; the colon survives untouched.
        assert.ok(eValues.includes("'builtin:codemode'"), `expected -e 'builtin:codemode', got: ${JSON.stringify(eValues)}`);
        // The unescaped, verbatim form must appear exactly once (no double
        // quoting or mangled colon).
        assert.equal(eValues.filter((v) => v.includes("builtin:codemode")).length, 1);
        assert.ok(!eValues.some((v) => v.includes("builtin:\\")), "no mangled colon in the builtin spec");
        // The --tools allowlist carries codemode (so the child activates it).
        const toolsIdx = parts.indexOf("--tools");
        assert.ok(toolsIdx >= 0, "expected --tools");
        assert.ok(parts[toolsIdx + 1].includes("codemode"), "expected codemode in the --tools value");
        // Plain built-ins are NOT emitted as extensions (no regression).
        assert.ok(!eValues.some((v) => /read|grep|find|ls|bash/.test(v)), `no -e for plain built-ins, got: ${JSON.stringify(eValues)}`);
      } finally {
        testApi.__setAlwaysOnExtensionsConfigForTest(null);
      }
    });
  });

  it("S4: applySandboxToParts does NOT emit builtin:codemode when codemode is absent from the allowlist", () => {
    withTempDir((d) => {
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const parts: string[] = [];
        testApi.applySandboxToParts(
          parts,
          {
            agent: "researcher",
            toolAllowlist: "web_fetch,ask_question",
            model: null,
            thinking: null,
            systemPromptMode: null,
            identity: null,
            spawnable: null,
            alwaysOnExtensions: null,
            autoExit: true,
            cwd: null,
            agentDir: null,
          },
          { artifactDir: d, name: "researcher" },
        );
        const eValues = parts
          .map((p, i) => (p === "-e" ? parts[i + 1] : null))
          .filter((p): p is string => p !== null);
        assert.ok(!eValues.some((v) => v.includes("builtin:")), `no builtin: spec expected, got: ${JSON.stringify(eValues)}`);
        const toolsIdx = parts.indexOf("--tools");
        assert.ok(toolsIdx >= 0, "expected --tools");
        assert.ok(!parts[toolsIdx + 1].includes("codemode"), "codemode not in the --tools value");
      } finally {
        testApi.__setAlwaysOnExtensionsConfigForTest(null);
      }
    });
  });


  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
    // S4: codemode is an extension tool (not a builtin) and passes through to
    // the child's --tools verbatim, so the child activates it.
    assert.equal(
      testApi.buildSubagentToolAllowlist("read, bash, codemode"),
      "read,bash,codemode,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildSubagentToolAllowlist withholds the control tools when omitControlTools is set (background children)", () => {
    // Default: the control tool is always appended so a restricted child can
    // still ask_question.
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash"),
      "read,bash,ask_question",
    );
    // omitControlTools: the child control tools are NOT appended, so `--tools`
    // agrees with the child side refusing to register ask_question.
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash", { omitControlTools: true }),
      "read,bash",
    );
    // Still null without a restriction (no reason to emit --tools).
    assert.equal(
      testApi.buildSubagentToolAllowlist(undefined, { omitControlTools: true }),
      null,
    );
    // A grantSpawning child keeps its spawning tools but loses the control tool.
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash", { grantSpawning: true, omitControlTools: true }),
      "read,bash,subagent,subagent_interrupt,subagent_message,subagents_list",
    );
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,web_search",
          model: "litellm/coding-reasoning",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          alwaysOnExtensions: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("litellm/coding-reasoning:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,web_search"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("applySandboxToParts adds always-on extensions to the explicit -e list", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    let warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => { warned.push(String(msg)); };
    withTempDir((d) => {
      process.env.PI_CODING_AGENT_DIR = d;
      // An always-on extension directory (package.json + pi.extensions manifest).
      const guardDir = join(d, "guard");
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(
        join(guardDir, "package.json"),
        JSON.stringify({ name: "guard", type: "module", pi: { extensions: ["./index.ts"] } }),
      );
      writeFileSync(join(guardDir, "index.ts"), "export default (pi) => {};\n");
      // The extension backing the web_search tool (per the tool map:
      // <agentDir>/extensions/web-search/index.ts), so the tool-backing
      // assertion below is deterministic under the isolated agent dir.
      const webSearchExtDir = join(d, "extensions", "web-search");
      mkdirSync(webSearchExtDir, { recursive: true });
      writeFileSync(join(webSearchExtDir, "index.ts"), "export default (pi) => {};\n");

      const { resolveAlwaysOnExtensionPaths, applySandboxToParts, __setAlwaysOnExtensionsConfigForTest } = testApi;

      // Empty config: no always-on paths, nothing added.
      __setAlwaysOnExtensionsConfigForTest([]);
      assert.deepEqual(resolveAlwaysOnExtensionPaths(), []);

      // Configured extension directory: resolved into the child's -e list.
      __setAlwaysOnExtensionsConfigForTest([guardDir]);
      assert.deepEqual(resolveAlwaysOnExtensionPaths(), [guardDir]);

      const parts: string[] = [];
      applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,web_search",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const eFlags = parts.filter((p) => p === "-e");
      const eValues = parts
        .map((p, i) => (p === "-e" ? parts[i + 1] : null))
        .filter((p): p is string => p !== null)
        .map((v) => v.replace(/^'/, "").replace(/'$/, "")); // unshell-escape
      assert.ok(eFlags.length >= 1, "expected -e flags");
      // The always-on extension dir is passed as-is (pi resolves the manifest itself).
      assert.ok(eValues.includes(guardDir), `expected ${guardDir} among -e values: ${eValues}`);
      // Tool-backing extensions are still present (deduped with the always-on set).
      const webSearchIdx = eValues.findIndex((v) => v === join(webSearchExtDir, "index.ts"));
      assert.ok(
        webSearchIdx >= 0,
        `expected ${join(webSearchExtDir, "index.ts")} among -e values: ${eValues}`,
      );

      // A configured path that disappeared at spawn time is dropped with a warning.
      __setAlwaysOnExtensionsConfigForTest([join(d, "gone")]);
      warned = [];
      assert.deepEqual(resolveAlwaysOnExtensionPaths(), []);
      assert.equal(warned.length, 1);
      assert.match(warned[0], /does not exist/);

      // An unrestricted loadout is untouched: no -e for always-on extensions
      // (the child keeps normal global discovery, which loads them if installed).
      const bare: string[] = [];
      applySandboxToParts(
        bare,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.ok(!bare.includes(guardDir), "unrestricted loadout must not gain -e flags");
    });
    process.env.PI_CODING_AGENT_DIR = previous;
    console.warn = origWarn;
    testApi.__setAlwaysOnExtensionsConfigForTest(null);
  });

  it("applySandboxToParts replays the loadout's per-agent always-on extensions on resume", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    withTempDir((d) => {
      process.env.PI_CODING_AGENT_DIR = d;
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      const agentExtDir = join(d, "agent-guard");
      mkdirSync(agentExtDir, { recursive: true });
      writeFileSync(join(agentExtDir, "index.ts"), "export default (pi) => {};\n");

      // No global config entry, but the loadout snapshot carries the agent's
      // own entry (as written at spawn time from its frontmatter).
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,bash",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: [agentExtDir],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const eValues = parts
        .map((p, i) => (p === "-e" ? parts[i + 1] : null))
        .filter((p): p is string => p !== null)
        .map((v) => v.replace(/^'/, "").replace(/'$/, "")); // unshell-escape
      assert.ok(eValues.includes(agentExtDir), `expected ${agentExtDir} among -e values: ${eValues}`);
    });
    process.env.PI_CODING_AGENT_DIR = previous;
    testApi.__setAlwaysOnExtensionsConfigForTest(null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => -1, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => "two", () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => { throw new Error("boom"); }, () => assert.equal(runningChildrenCount(), 0));
    });
  });


  // S1: the park/exit gate moved from `agent_end` to `agent_settled` (decision 2).
  // These tests lock in the split's invariants, including the spike-confirmed case
  // where `agent_settled` fires while children are still running (it must park,
  // not exit, and then exit once the children finish and their results land).
  describe("agent_end / agent_settled split", () => {
    const CHILD_KEY = Symbol.for("pi-subagents/running-children-count");

    function setup(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-split";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { emit, restore };
    }

    function withChildren(count: number, run: () => void) {
      const prev = (globalThis as any)[CHILD_KEY];
      (globalThis as any)[CHILD_KEY] = () => count;
      try {
        run();
      } finally {
        (globalThis as any)[CHILD_KEY] = prev;
      }
    }

    it("exits on agent_settled (no children, not aborted, autoExit, clean stopReason)", () => {
      const dir = createTestDir();
      const { emit, restore } = setup(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, { shutdown() {} });
        let shutdown = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "a clean, child-free, un-aborted run must auto-exit on settled");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("never shuts down from agent_end alone (message inspection only)", () => {
      const dir = createTestDir();
      const { emit, restore } = setup(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        let shutdown = false;
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "agent_end must inspect only and never shut down");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks on agent_settled while children are still running, then exits once they finish", () => {
      const dir = createTestDir();
      const { emit, restore } = setup(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, { shutdown() {} });
        let parked = true;
        withChildren(1, () => {
          emit("agent_settled", { aborted: false }, { shutdown() { parked = false; } });
        });
        assert.equal(parked, true, "children still running - settled must park, not exit");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, { shutdown() {} });
        let exited = false;
        withChildren(0, () => {
          emit("agent_settled", { aborted: false }, { shutdown() { exited = true; } });
        });
        assert.equal(exited, true, "children finished + settled - exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not auto-exit when the run was aborted", () => {
      const dir = createTestDir();
      const { emit, restore } = setup(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, { shutdown() {} });
        let shutdown = false;
        emit("agent_settled", { aborted: true }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "an aborted run must not auto-exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not auto-exit when the turn's stopReason was 'aborted'", () => {
      const dir = createTestDir();
      const { emit, restore } = setup(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, { shutdown() {} });
        let shutdown = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "a turn whose last assistant message was aborted must not auto-exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("defers the .exit sidecar to the settled exit branch so a parked error turn does not trip the watcher", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setup(sessionFile);
      try {
        emit("agent_start");
        withChildren(1, () => {
          emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }] }, { shutdown() {} });
        });
        assert.ok(!existsSync(`${sessionFile}.exit`), "agent_end must not write the .exit sidecar while children are running");
        let parked = true;
        withChildren(1, () => {
          emit("agent_settled", { aborted: false }, { shutdown() { parked = false; } });
        });
        assert.equal(parked, true, "settled must park, not exit, while children are still running");
        assert.ok(!existsSync(`${sessionFile}.exit`), "a parked error turn must not leave a sidecar for the watcher's .exit fast path");
        let exited = false;
        withChildren(0, () => {
          emit("agent_settled", { aborted: false }, { shutdown() { exited = true; } });
        });
        assert.equal(exited, true, "settled with no children must exit");
        assert.ok(existsSync(`${sessionFile}.exit`), "the exit branch must write the .exit sidecar with the stashed error");
        const payload = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf-8"));
        assert.equal(payload.type, "error");
        assert.equal(payload.errorMessage, "529 overloaded");
        assert.equal(payload.stopReason, "error");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("withholds ask_question in background children (PI_SUBAGENT_BACKEND=background, read at registration)", () => {
      const dir = createTestDir();
      // The child-side guard (isBackgroundChild) reads the env var at
      // registration time, so set it BEFORE the extension registers its tools.
      const savedBackend = process.env.PI_SUBAGENT_BACKEND;
      process.env.PI_SUBAGENT_BACKEND = "background";
      let mock; let restore;
      try {
        ({ mock, restore } = setupSubagentExtension(join(dir, "s.jsonl")));
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(!names.includes("ask_question"), "background child must not register ask_question");
      } finally {
        if (restore) restore();
        if (savedBackend === undefined) delete process.env.PI_SUBAGENT_BACKEND;
        else process.env.PI_SUBAGENT_BACKEND = savedBackend;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still registers ask_question when PI_SUBAGENT_BACKEND names a multiplexer backend", () => {
      const dir = createTestDir();
      const savedBackend = process.env.PI_SUBAGENT_BACKEND;
      process.env.PI_SUBAGENT_BACKEND = "tmux";
      let mock; let restore;
      try {
        ({ mock, restore } = setupSubagentExtension(join(dir, "s.jsonl")));
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"), "multiplexer child keeps ask_question");
      } finally {
        if (restore) restore();
        if (savedBackend === undefined) delete process.env.PI_SUBAGENT_BACKEND;
        else process.env.PI_SUBAGENT_BACKEND = savedBackend;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        const askFile = `${sessionFile}.ask`;
        assert.ok(existsSync(askFile), ".ask signal file should be written");
        const payload = JSON.parse(readFileSync(askFile, "utf-8"));
        assert.equal(payload.question, "Which API base URL?");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        // No .exit sidecar — the session is not exiting.
        assert.ok(!existsSync(`${sessionFile}.exit`));
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    //
    // Under the S1 event split the park/exit gate lives on `agent_settled`
    // (`agent_end` only inspects messages and never shuts down), so these
    // tests emit `agent_end` + `agent_settled` and assert the decision is made
    // on the settled event.
    function setupCapturingExtension(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = async () => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, { shutdown() {} });
      };
      return { emit, ask, restore };
    }

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets awaitingAnswer mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        // agent_end inspects only — it must not shut down by itself.
        let endShutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { endShutdown = true; } });
        assert.equal(endShutdown, false, "agent_end never shuts down under the split");
        // The exit decision is made on agent_settled.
        let shutdown = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "reply consumed mid-run + settled → exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_settled while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let endShutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { endShutdown = true; } });
        assert.equal(endShutdown, false);
        let shutdown = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let endShutdown1 = false;
        emit("agent_end", { messages: [] }, { shutdown() { endShutdown1 = true; } });
        let shutdown1 = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown1 = true; } });
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        emit("agent_end", { messages: [] }, { shutdown() {} });
        let shutdown2 = false;
        emit("agent_settled", { aborted: false }, { shutdown() { shutdown2 = true; } });
        assert.equal(shutdown2, true, "after the reply turn, settled should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("resolveWaitingReason", () => {
    it("applies the Q1 priority matrix: aborted → null, question beats children, neither → null", () => {
      assert.equal(resolveWaitingReason(true, false, false), null);
      assert.equal(resolveWaitingReason(true, true, true), null);
      assert.equal(resolveWaitingReason(false, true, true), "ask_question");
      assert.equal(resolveWaitingReason(false, true, false), "ask_question");
      assert.equal(resolveWaitingReason(false, false, true), "own_children");
      assert.equal(resolveWaitingReason(false, false, false), null);
    });
  });

  // The "subagent-tools" widget above the subagent's editor is click-
  // expandable (left click toggles, like the parent-side subagent results),
  // not only toggleable via the Ctrl+Alt+O shortcut.
  describe("subagent-tools widget click-to-expand", () => {
    const CLICK = { type: "click", button: "left" } as const;

    function makeTheme() {
      return {
        fg(_color: string, text: string) {
          return text;
        },
        bg(_color: string, text: string) {
          return text;
        },
        bold(text: string) {
          return text;
        },
      };
    }

    function setupWidgetExtension() {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const shortcuts: Array<any> = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut(shortcut: string, options: any) {
          shortcuts.push({ shortcut, options });
        },
        sendUserMessage() {},
        sendMessage() {},
        getAllTools() {
          return [{ name: "bash" }, { name: "read" }, { name: "edit" }];
        },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
        deny: process.env.PI_DENY_TOOLS,
      };
      process.env.PI_SUBAGENT_NAME = "widget-worker";
      process.env.PI_SUBAGENT_AGENT = "worker";
      process.env.PI_DENY_TOOLS = "subagent";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
        restoreEnvVar("PI_DENY_TOOLS", saved.deny);
      };
      return { emit, shortcuts, restore };
    }

    function mountedWidget(emit: (event: string, ...args: any[]) => void) {
      // Capture the setWidget call and invoke the factory once, the way pi's
      // setExtensionWidget does.
      const ctx: any = {
        ui: {
          setWidget(key: string, factory: any, options: any) {
            ctx.ui.key = key;
            ctx.ui.factory = factory;
            ctx.ui.options = options;
          },
        },
      };
      emit("session_start", {}, ctx);
      assert.equal(ctx.ui.key, "subagent-tools");
      assert.deepEqual(ctx.ui.options, { placement: "aboveEditor" });
      return ctx.ui.factory(null, makeTheme());
    }

    it("registers the widget and toggles between collapsed and expanded on left click", () => {
      const { emit, restore } = setupWidgetExtension();
      try {
        const component = mountedWidget(emit);

        // Collapsed: one-line summary, no tool list.
        let output = component.render(80).join("\n");
        assert.match(output, /\[worker\] — 3 tools · 1 denied  \(Ctrl\+Alt\+O to expand\)/);
        assert.doesNotMatch(output, /bash, read, edit/);

        // A left click toggles it open (the TUI synthesizes a click on release).
        assert.deepEqual(component.handleMouse(CLICK), { handled: true });
        output = component.render(80).join("\n");
        assert.match(output, /\[worker\] — 3 available  \(Ctrl\+Alt\+O to collapse\)/);
        assert.match(output, /bash, edit, read/);
        assert.match(output, /denied: subagent/);

        // Another click collapses it again.
        assert.deepEqual(component.handleMouse(CLICK), { handled: true });
        output = component.render(80).join("\n");
        assert.match(output, /3 tools · 1 denied  \(Ctrl\+Alt\+O to expand\)/);
        assert.doesNotMatch(output, /bash, read, edit/);
      } finally {
        restore();
      }
    });

    it("ignores non-left-click mouse events", () => {
      const { emit, restore } = setupWidgetExtension();
      try {
        const component = mountedWidget(emit);
        assert.equal(component.handleMouse({ type: "press", button: "left" }), undefined);
        assert.equal(component.handleMouse({ type: "release", button: "left" }), undefined);
        assert.equal(component.handleMouse({ type: "click", button: "right" }), undefined);
        assert.equal(component.handleMouse({ type: "click", button: "middle" }), undefined);
        // Still collapsed (unchanged).
        assert.match(component.render(80).join("\n"), /to expand/);
      } finally {
        restore();
      }
    });

    it("the Ctrl+Alt+O shortcut and the click toggle the SAME live state", () => {
      const { emit, shortcuts, restore } = setupWidgetExtension();
      try {
        const component = mountedWidget(emit);
        const toggle = shortcuts.find((s) => s.shortcut === "ctrl+alt+o");
        assert.ok(toggle, "expected the Ctrl+Alt+O shortcut to be registered");

        // Click to expand.
        component.handleMouse(CLICK);
        assert.match(component.render(80).join("\n"), /to collapse/);

        // The shortcut collapses the SAME component instance — no re-render
        // request in between, so the mounted component must reflect it live.
        const ctx: any = { ui: { setWidget() {} } };
        toggle.options.handler(ctx);
        assert.match(component.render(80).join("\n"), /to expand/);
      } finally {
        restore();
      }
    });

    it("re-registering the widget (shortcut handler) keeps a working component", () => {
      const { emit, shortcuts, restore } = setupWidgetExtension();
      try {
        const first = mountedWidget(emit);
        // Expand via click.
        assert.deepEqual(first.handleMouse(CLICK), { handled: true });
        assert.match(first.render(80).join("\n"), /to collapse/);

        const toggle = shortcuts.find((s) => s.shortcut === "ctrl+alt+o");
        // The shortcut handler flips the same state AND re-calls setWidget,
        // replacing the mounted component. The replacement must keep
        // rendering the live state and stay clickable.
        const ctx: any = {
          ui: {
            setWidget(_key: string, factory: any) {
              ctx.ui.factory = factory;
            },
          },
        };
        toggle.options.handler(ctx);
        const replaced = ctx.ui.factory(null, makeTheme());
        // The shortcut collapsed it; the replacement reflects that live.
        assert.match(replaced.render(80).join("\n"), /to expand/);
        // Clickable too, and the old and new instances share the closure
        // state (a click on the replacement is visible on the old one).
        assert.deepEqual(replaced.handleMouse(CLICK), { handled: true });
        assert.match(replaced.render(80).join("\n"), /to collapse/);
        assert.match(first.render(80).join("\n"), /to collapse/);
      } finally {
        restore();
      }
    });
  });
});

describe("tmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("no longer decodes ping payloads (ask_question keeps the session open instead)", () => {
    // ask_question writes a `.ask` signal, not a `.exit` ping sidecar, so an
    // unknown `type: "ping"` payload now falls through to a clean done.
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      { reason: "done", exitCode: 0 },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });


  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("reports a name collision even when no multiplexer is available", async () => {
    const saved = process.env.HERDR_ENV;
    const savedTmux = process.env.TMUX;
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // Suppress the detected backend (and its cache) so isMuxAvailable() is
      // false, proving the collision refusal is not shadowed by the
      // multiplexer prerequisite.
      delete process.env.HERDR_ENV;
      delete process.env.TMUX;
      __setBackendForTest__(null);

      runningMap.set(
        "a1",
        {
          id: "499163e0",
          name: "f1-indirection",
          task: "",
          surface: "pane-1",
          startTime: Date.now() - 60_000,
          sessionFile: "/tmp/x.jsonl",
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        },
      );

      const result = await subagentTool.execute(
        "call-1",
        { agent: "worker", name: "f1-indirection", task: "do it" },
        undefined,
        undefined,
        {
          sessionManager: {
            getSessionFile: () => "/tmp/sess.jsonl",
            getSessionId: () => "sess-1",
            getSessionDir: () => "/tmp/sessions",
          },
          cwd: "/tmp",
        } as any,
      );

      assert.equal(result.details?.error, "name collision");
      assert.equal(result.details?.kind, "running");
    } finally {
      if (saved === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = saved;
      if (savedTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = savedTmux;
      __setBackendForTest__(null);
      runningMap.clear();
    }
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // `name` is now optional: a short descriptive label for the pane/tab and widget row.
    assert.match(props.name.description, /pane\/tab and widget row/);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("registers subagent_interrupt (and never subagent_resume)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), true);
    assert.equal(names.includes("subagent_resume"), false);
  });
});

describe("subagent / subagent_message tool blocks expand on click / Ctrl+O", () => {
  // keyHint() (the collapsed "to expand" hint) reads pi-coding-agent's global
  // theme singleton, which throws until initialized — it ignores the theme
  // passed to the renderer. Seed it for these tests (the real TUI always has
  // one); same pattern as the message-renderer tests below.
  const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = (globalThis as any)[THEME_KEY];

  let subagentTool: any;
  let messageTool: any;
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };

  beforeEach(() => {
    (globalThis as any)[THEME_KEY] = theme;
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(subagentTool, "expected subagent tool to be registered");
    assert.ok(messageTool, "expected subagent_message tool to be registered");
  });

  afterEach(() => {
    if (previousTheme === undefined) {
      delete (globalThis as any)[THEME_KEY];
    } else {
      (globalThis as any)[THEME_KEY] = previousTheme;
    }
  });

  function renderedText(component: any): string {
    // Strip ANSI escapes (keyHint output carries them) before asserting.
    return component.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  }

  it("subagent collapsed: preview line + line count + expand hint", () => {
    const output = renderedText(
      subagentTool.renderCall({ name: "x", task: "line1\nline2\nline3" }, theme, {
        expanded: false,
        argsComplete: true,
      }),
    );
    assert.match(output, /line1/);
    assert.match(output, / \(3 lines\)/);
    assert.match(output, /to expand/);
    assert.doesNotMatch(output, /line2/);
  });

  it("subagent expanded: full task, no counter or hint", () => {
    const output = renderedText(
      subagentTool.renderCall({ name: "x", task: "line1\nline2\nline3" }, theme, {
        expanded: true,
        argsComplete: true,
      }),
    );
    assert.match(output, /line1/);
    assert.match(output, /line2/);
    assert.match(output, /line3/);
    assert.doesNotMatch(output, /\(3 lines\)/);
    assert.doesNotMatch(output, /to expand/);
    assert.doesNotMatch(output, /…/);
  });

  it("subagent streaming (expanded but args incomplete): stays in preview form", () => {
    const output = renderedText(
      subagentTool.renderCall({ name: "x", task: "partial one\npartial two" }, theme, {
        expanded: true,
        argsComplete: false,
        isPartial: true,
      }),
    );
    assert.match(output, /partial one/);
    assert.match(output, /to expand/);
    assert.doesNotMatch(output, /partial two/);

    // Two-arg call (default context, e.g. HTML export) still works and is collapsed.
    const twoArg = renderedText(
      subagentTool.renderCall({ name: "x", task: "partial one\npartial two" }, theme),
    );
    assert.match(twoArg, /partial one/);
    assert.match(twoArg, /to expand/);
    assert.doesNotMatch(twoArg, /partial two/);
  });

  it("restored rows (isPartial false, argsComplete false) expand to full payload", () => {
    // pi's session-restore path never calls setArgsComplete(), so restored
    // rows sit at argsComplete: false, isPartial: false — they must expand.
    const subagentOutput = renderedText(
      subagentTool.renderCall({ name: "x", task: "line1\nline2\nline3" }, theme, {
        expanded: true,
        argsComplete: false,
        isPartial: false,
      }),
    );
    assert.match(subagentOutput, /line1/);
    assert.match(subagentOutput, /line2/);
    assert.match(subagentOutput, /line3/);
    assert.doesNotMatch(subagentOutput, /\(3 lines\)/);
    assert.doesNotMatch(subagentOutput, /to expand/);

    const messageOutput = renderedText(
      messageTool.renderCall({ name: "y", message: "first\nsecond" }, theme, {
        expanded: true,
        argsComplete: false,
        isPartial: false,
      }),
    );
    assert.match(messageOutput, /first/);
    assert.match(messageOutput, /second/);
    assert.doesNotMatch(messageOutput, /\(2 lines\)/);
    assert.doesNotMatch(messageOutput, /to expand/);
  });

  it("subagent_message collapsed: preview line + line count + expand hint", () => {
    const output = renderedText(
      messageTool.renderCall({ name: "y", message: "first\nsecond" }, theme, {
        expanded: false,
        argsComplete: true,
      }),
    );
    assert.match(output, /first/);
    assert.match(output, / \(2 lines\)/);
    assert.match(output, /to expand/);
    assert.doesNotMatch(output, /second/);
  });

  it("subagent_message expanded: full message, no counter or hint", () => {
    const output = renderedText(
      messageTool.renderCall({ name: "y", message: "first\nsecond" }, theme, {
        expanded: true,
        argsComplete: true,
      }),
    );
    assert.match(output, /first/);
    assert.match(output, /second/);
    assert.doesNotMatch(output, /\(2 lines\)/);
    assert.doesNotMatch(output, /to expand/);
  });

  it("subagent_message without message: header only, no throw", () => {
    const output = renderedText(messageTool.renderCall({ name: "y" }, theme, {}));
    assert.match(output, /— message/);
    assert.match(output, /y/);
    assert.doesNotMatch(output, /to expand/);
    assert.doesNotMatch(output, /lines\)/);
  });

  it("renderResult stays a status line (no payload leak)", () => {
    // subagent: — started, even when details carries the full task.
    const spawnResult = renderedText(
      subagentTool.renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: { status: "started", name: "s1", task: "secret task payload" },
        },
        {},
        theme,
      ),
    );
    assert.match(spawnResult, /⟳/);
    assert.match(spawnResult, /s1/);
    assert.match(spawnResult, /— started/);
    assert.doesNotMatch(spawnResult, /secret task payload/);

    // subagent_message: steer / resume, without the message payload.
    const steered = renderedText(
      messageTool.renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: { status: "steered", name: "m1", message: "secret message payload" },
        },
        {},
        theme,
      ),
    );
    assert.match(steered, /m1/);
    assert.match(steered, /message delivered/);
    assert.doesNotMatch(steered, /secret message payload/);

    const resumed = renderedText(
      messageTool.renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: { status: "started", name: "m1", message: "secret message payload" },
        },
        {},
        theme,
      ),
    );
    assert.match(resumed, /m1/);
    assert.match(resumed, /resumed/);
    assert.doesNotMatch(resumed, /secret message payload/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setWaitingReason writes and deletes the waiting reason field", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-w1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-w1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.agentEndWaiting();
      recorder.setWaitingReason("own_children");
      let read = readSubagentActivityFile(activityFile, "child-w1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingReason, "own_children");

      // A later park recompute can switch or clear the reason.
      recorder.setWaitingReason("ask_question");
      read = readSubagentActivityFile(activityFile, "child-w1");
      assert.ok(read.ok);
      assert.equal(read.activity.waitingReason, "ask_question");

      recorder.setWaitingReason(null);
      read = readSubagentActivityFile(activityFile, "child-w1");
      assert.ok(read.ok);
      assert.equal(read.activity.waitingReason, undefined);
      assert.ok(!("waitingReason" in read.activity));
    });
  });

  it("rejects non-enum waitingReason values but accepts both enum members", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const bad = getSubagentActivityFile(dir, "child-w-bad");
      writeFileSync(
        bad,
        `${JSON.stringify(validActivity({ runningChildId: "child-w-bad", waitingReason: "stalled" }))}\n`,
      );
      const badRead = readSubagentActivityFile(bad, "child-w-bad");
      assert.equal(badRead.ok, false);
      assert.equal((badRead as { ok: false; reason: string }).reason, "invalid");

      const goodFile = getSubagentActivityFile(dir, "child-w-good");
      writeFileSync(
        goodFile,
        `${JSON.stringify(validActivity({ runningChildId: "child-w-good", waitingReason: "own_children" }))}\n`,
      );
      const goodRead = readSubagentActivityFile(goodFile, "child-w-good");
      assert.ok(goodRead.ok);
      assert.equal(goodRead.activity.waitingReason, "own_children");
    });
  });

  it("markActive and markDone clear a previously set waiting reason", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-w2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-w2",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.agentEndWaiting();
      recorder.setWaitingReason("own_children");

      // markActive: a new turn starts after the park — the stale reason must
      // not survive into the active phase.
      recorder.agentStart();
      let read = readSubagentActivityFile(activityFile, "child-w2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.waitingReason, undefined);
      assert.ok(!("waitingReason" in read.activity));

      // markDone: exiting after a park — same rule.
      recorder.agentStart();
      recorder.agentEndWaiting();
      recorder.setWaitingReason("ask_question");
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-w2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.waitingReason, undefined);
      assert.ok(!("waitingReason" in read.activity));
    });
  });

  it("validates old activity files without the waitingReason field (backward compat)", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "child-1");
      // An activity file written before the waitingReason field existed:
      // phase waiting, no waitingReason key at all.
      writeFileSync(
        activityFile,
        `${JSON.stringify({ ...validActivity(), waitingSince: 1_000, phase: "waiting", latestEvent: "agent_end" })}\n`,
      );

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingReason, undefined);
    });
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and subagent_interrupt, not the old resume tool", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), true);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("delivers the steer message to the backend without pre-flattening", () => {
    // Flattening for raw-pane delivery happens in the backend (tmux facade,
    // herdr agent-not-found fallback), not in steerSubagent: on herdr the
    // message goes through `agent prompt` (bracketed paste, multi-line safe).
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this\nthen that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent_interrupt (S2 cancellation tool)", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "do the thing",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  let runningMap: Map<string, any>;
  let testApi: any;
  beforeEach(() => {
    testApi = (subagentsModule as any).__test__;
    runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
  });
  afterEach(() => {
    runningMap.clear();
    __setBackendForTest__(null);
    restoreEnvVar("PI_SUBAGENT_NAME", undefined);
    restoreEnvVar("PI_SUBAGENT_AGENT", undefined);
  });

  // ── Schema / parameter refusals (via the resolver) ──

  it("rejects when both id and name are given", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker" }));
    const r = testApi.resolveRunningForInterrupt({ id: "a1", name: "Worker" });
    assert.ok("error" in r);
    assert.match((r as any).error, /exactly one/i);
    assert.match((r as any).error, /got both/i);
  });

  it("rejects when neither id nor name is given", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker" }));
    const r = testApi.resolveRunningForInterrupt({});
    assert.ok("error" in r);
    assert.match((r as any).error, /got neither/i);
  });

  it("resolves an unknown id as a clear error", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker" }));
    const r = testApi.resolveRunningForInterrupt({ id: "zzz" });
    assert.ok("error" in r);
    assert.match((r as any).error, /No running subagent with id "zzz"/);
  });

  it("resolves an unknown name as a clear error", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker" }));
    const r = testApi.resolveRunningForInterrupt({ name: "Ghost" });
    assert.ok("error" in r);
    assert.match((r as any).error, /No running subagent named "Ghost"/);
  });

  it("resolves a finished handle (not in runningSubagents) as a clear error, never a resume", () => {
    // A finished subagent has been removed from runningSubagents; the resolver
    // must refuse it (it can not fall through to a resume path).
    runningMap.clear();
    const r = testApi.resolveRunningForInterrupt({ name: "FinishedOne" });
    assert.ok("error" in r);
    assert.match((r as any).error, /No running subagent named "FinishedOne"/);
  });

  it("resolves an ambiguous name as a clear error", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1" }));
    runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2" }));
    const r = testApi.resolveRunningForInterrupt({ name: "Worker" });
    assert.ok("error" in r);
    assert.match((r as any).error, /Ambiguous subagent name/);
  });

  // ── Actor attribution (from caller env, never tool args) ──

  it("attributes top-level (no PI_SUBAGENT_NAME) to main_agent", () => {
    delete process.env.PI_SUBAGENT_NAME;
    assert.equal(testApi.interruptingActor(), "main_agent");
  });

  it("attributes a subagent caller to its runtime name (PI_SUBAGENT_NAME)", () => {
    process.env.PI_SUBAGENT_NAME = "worker-42";
    assert.equal(testApi.interruptingActor(), "worker-42");
  });

  it("notice carries the actor, not the id, and reports no result follows", () => {
    const text = testApi.formatInterruptedNotice("Scout", "main_agent", 12);
    assert.match(text, /Sub-agent "Scout" was interrupted by main_agent \(12s\)/);
    assert.match(text, /No result will follow/i);
    // Actor, not a raw id, is what is surfaced.
    assert.doesNotMatch(text, /a1/);
  });

  // ── Flag set before teardown + revert on failure ──

  it("sets userInterrupted BEFORE sending the signal and closes the surface", async () => {
    const order: string[] = [];
    let flagAtSignalTime: boolean | undefined;
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1" }));
    const target = runningMap.get("a1");

    const result = await testApi.handleSubagentInterrupt(
      { name: "Worker" },
      {
        signal: async (_surface: string) => {
          order.push("signal");
          flagAtSignalTime = target.userInterrupted;
        },
        close: () => {
          order.push("close");
        },
      },
    );

    assert.equal(result.details?.status, "interrupt_requested");
    assert.equal(flagAtSignalTime, true, "flag must be set before the signal is sent");
    assert.deepEqual(order, ["signal", "close"]);
  });

  it("reverts userInterrupted when teardown fails, so a live child keeps its completion path", async () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1" }));
    const target = runningMap.get("a1");
    const result = await testApi.handleSubagentInterrupt(
      { name: "Worker" },
      {
        signal: async () => {},
        close: () => {
          throw new Error("pane close failed");
        },
      },
    );
    assert.equal(result.details?.status, "interrupt_failed");
    assert.equal(target.userInterrupted, undefined, "flag must be reverted after a failed teardown");
    assert.equal(result.details?.error?.includes("pane close failed"), true);
  });

  it("reports interrupt_already_requested for a second interrupt of the same handle", async () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", userInterrupted: true }));
    const result = await testApi.handleSubagentInterrupt(
      { name: "Worker" },
      { signal: async () => {}, close: () => {} },
    );
    assert.equal(result.details?.status, "interrupt_already_requested");
    assert.match(result.content[0].text, /already interrupted/i);
  });

  it("treats an already-gone pane (child died mid-race) as a successful interrupt, keeping the flag", async () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1" }));
    const target = runningMap.get("a1");
    const result = await testApi.handleSubagentInterrupt(
      { name: "Worker" },
      {
        signal: async () => {
          throw new Error('herdr pane send-keys … failed: {"error":{"code":"pane_not_found","message":"pane w7:pX not found"}}');
        },
        close: () => {
          throw new Error("tmux: can't find pane");
        },
      },
    );
    assert.equal(result.details?.status, "interrupt_requested", "a gone pane is not a teardown failure");
    assert.equal(target.userInterrupted, true, "the flag stays set so the watcher classifies the exit as interrupted");
  });

  // ── Stale .ask cleanup: an interrupted child that had just called
  // ask_question leaves its .ask signal on disk; a later same-name respawn in
  // the same cwd reuses the session file and its fresh watcher would deliver
  // the dead child's question. The interrupt teardown must clear it. ──

  it("teardown success unlinks the child's stale .ask signal", async () => {
    const root = createTestDir();
    const sessionFile = join(root, "worker.jsonl");
    writeFileSync(sessionFile, "{}");
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, JSON.stringify({ question: "stale question from the dead child" }));
    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", sessionFile }));
      const result = await testApi.handleSubagentInterrupt(
        { name: "Worker" },
        { signal: async () => {}, close: () => {} },
      );
      assert.equal(result.details?.status, "interrupt_requested");
      assert.equal(existsSync(askFile), false, "the stale .ask signal must be unlinked on teardown success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("teardown failure (revert path) also unlinks the stale .ask signal", async () => {
    const root = createTestDir();
    const sessionFile = join(root, "worker.jsonl");
    writeFileSync(sessionFile, "{}");
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, JSON.stringify({ question: "stale question from the dead child" }));
    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", sessionFile }));
      const result = await testApi.handleSubagentInterrupt(
        { name: "Worker" },
        {
          signal: async () => {},
          close: () => {
            throw new Error("pane close failed");
          },
        },
      );
      assert.equal(result.details?.status, "interrupt_failed");
      assert.equal(
        existsSync(askFile),
        false,
        "the stale .ask signal must be unlinked even on the revert path (a dead child's question would otherwise reach a later same-name respawn)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("teardown success is a no-op when no .ask file exists", async () => {
    const root = createTestDir();
    const sessionFile = join(root, "worker.jsonl");
    writeFileSync(sessionFile, "{}");
    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", sessionFile }));
      const result = await testApi.handleSubagentInterrupt(
        { name: "Worker" },
        { signal: async () => {}, close: () => {} },
      );
      assert.equal(result.details?.status, "interrupt_requested");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to interrupt a Claude Code CLI child", async () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "ClaudeKid", surface: "pane-1", cli: "claude" }));
    let signalled = false;
    const result = await testApi.handleSubagentInterrupt(
      { name: "ClaudeKid" },
      {
        signal: async () => {
          signalled = true;
        },
        close: () => {},
      },
    );
    assert.equal(result.details?.status, "claude_not_supported");
    assert.match(result.content[0].text, /Claude Code CLI and cannot be interrupted/i);
    assert.equal(signalled, false, "no signal must be sent to a claude child");
  });

  // ── Steering refusal post-interrupt ──

  it("refuses to steer an interrupting/interrupted handle", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", userInterrupted: true }));
    const result = testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, () => {
      throw new Error("send must not be attempted after interrupt");
    });
    assert.equal(result.details?.status, "interrupted");
    assert.match(result.content[0].text, /was interrupted and is shutting down/i);
  });

  // ── Widget hiding for interrupted runs ──

  it("excludes userInterrupted runs from the visible widget list", () => {
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", userInterrupted: true }));
    runningMap.set("b2", makeRunning({ id: "b2", name: "Scout", surface: "b2" }));
    const visible = testApi.visibleRunningSubagents();
    assert.deepEqual(visible.map((r: any) => r.id), ["b2"]);
  });

  // ── finalizeInterruptedRun: one notice, skip normal completion ──

  it("steers ONE subagent_result with interrupted:true and interruption{actor,requestedAt}", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (m: any) => sent.push(m);
    runningMap.set("a1", makeRunning({
      id: "a1", name: "Worker", surface: "pane-1", sessionFile: "/tmp/worker.jsonl",
      interruptionActor: "main_agent", interruptedAt: 1732000000000,
    }));
    const target = runningMap.get("a1");

    const skip = testApi.finalizeInterruptedRun(api, target, {
      exitCode: 1, elapsed: 8, interrupted: true, sessionFile: "/tmp/worker.jsonl", sessionId: "019f-sess",
    });
    assert.equal(skip, true, "finalize must return true so the caller skips normal completion");
    assert.equal(sent.length, 1, "exactly one steer for the interruption");
    assert.equal(sent[0].customType, "subagent_result");
    assert.equal(sent[0].details.interrupted, true);
    assert.equal(sent[0].details.name, "Worker");
    assert.equal(sent[0].details.interruption.actor, "main_agent");
    assert.equal(sent[0].details.interruption.requestedAt, new Date(1732000000000).toISOString());
    assert.equal(sent[0].details.sessionId, "019f-sess");
    assert.match(sent[0].content, /was interrupted by main_agent/);
  });

  it("does NOT hijack a normal (non-interrupted) completion", () => {
    const { api } = createMockExtensionApi();
    const sent: any[] = [];
    api.sendMessage = (m: any) => sent.push(m);
    runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-1", sessionFile: "/tmp/worker.jsonl" }));
    const target = runningMap.get("a1");
    const skip = testApi.finalizeInterruptedRun(api, target, { exitCode: 0, elapsed: 8, interrupted: false });
    assert.equal(skip, false, "a clean completion must fall through to the normal path");
    assert.equal(sent.length, 0);
  });

  it("the registered tool exposes optional id+name and delegates to the handler", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t: any) => t.name === "subagent_interrupt");
    assert.ok(tool, "subagent_interrupt must be registered");
    // TypeBox shape: both params optional (exactly-one is enforced in the
    // handler so the error text stays under our control).
    assert.ok(tool.parameters.properties.id, "id must be an optional string property");
    assert.ok(tool.parameters.properties.name, "name must be an optional string property");
    assert.ok(!tool.parameters.required, "neither param is individually required");

    // Unknown target via the real tool path: clear refusal, no crash.
    const ctx = {
      sessionManager: { getSessionFile: () => "/tmp/x.jsonl", getSessionId: () => "x", getSessionDir: () => "/tmp" },
      cwd: "/tmp",
    } as any;
    const result = await tool.execute("call-1", { name: "Nobody" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /No running subagent named "Nobody"/);
    assert.equal(result.details?.error, result.content[0].text);
  });
});

describe("subagent spawn name collision", () => {
  /**
   * Minimal execute context for spawn-path tests. The name-collision check
   * runs before any multiplexer interaction, so no session file on disk is
   * needed - only the session dir/id to locate this spawner's registry.
   */
  function mockSpawnCtx(root = join(process.cwd(), "mock-spawn-ctx"), sessionId = "sess-parent") {
    const sessionDir = join(root, "sessions");
    return {
      sessionManager: {
        getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: root,
    } as any;
  }

  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("nameCollisionForSpawn detects running, in-flight, and finished-name conflicts", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Free name: no conflict on any count.
      assert.deepEqual(testApi.nameCollisionForSpawn("fresh"), {});

      // A currently-running subagent claiming the name wins.
      runningMap.set("a1", makeRunning({ id: "a1", name: "f1-indirection" }));
      reserved.add("f1-indirection");
      const runningHit = testApi.nameCollisionForSpawn("f1-indirection", {});
      assert.equal(runningHit.running.id, "a1");
      assert.equal(runningHit.reserved, undefined);

      // A name reserved by an in-flight parallel spawn (nothing running yet).
      reserved.add("pending");
      const reservedHit = testApi.nameCollisionForSpawn("pending");
      assert.equal(reservedHit.reserved, true);

      // A finished subagent's name lives in the registry.
      const registry = {
        "done-1": { sessionFile: "/s/done.jsonl", sessionId: "id-done" },
      };
      const registryHit = testApi.nameCollisionForSpawn("done-1", registry);
      assert.equal(registryHit.registryEntry.sessionFile, "/s/done.jsonl");

      // Registry names are only consulted when the registry is passed in.
      assert.deepEqual(testApi.nameCollisionForSpawn("done-1"), {});
      // A name absent from the registry is free even when the registry is passed.
      assert.deepEqual(testApi.nameCollisionForSpawn("other", registry), {});
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("refuses a spawn whose explicit name matches a running subagent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set(
        "a1",
        makeRunning({
          id: "499163e0",
          name: "f1-indirection",
          startTime: Date.now() - 21 * 60 * 1000,
        }),
      );

      const result = await subagentTool.execute(
        "call-1",
        { agent: "worker", name: "f1-indirection", task: "continue the work" },
        undefined,
        undefined,
        mockSpawnCtx(),
      );

      assert.equal(result.details?.error, "name collision");
      assert.equal(result.details?.kind, "running");
      assert.equal(result.details?.id, "499163e0");
      assert.match(result.content[0].text, /already running/);
      assert.match(result.content[0].text, /499163e0/);
      assert.match(result.content[0].text, /subagent_message/);
      // The refusal must not have created a pane or registered a name.
      assert.equal(runningMap.has("a1"), true);
      assert.equal(runningMap.size, 1);
    } finally {
      runningMap.clear();
    }
  });

  it("refuses a spawn whose explicit name matches a finished subagent in this session's registry", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const root = createTestDir();
    try {
      // Seed this spawner session's registry with a finished subagent. The
      // registry lives in the spawner's artifact dir:
      // <sessionDir>/artifacts/<sessionId>/subagent-registry.json.
      const sessionDir = join(root, "sessions");
      const adir = join(sessionDir, "artifacts", "sess-parent");
      registerName(adir, "f1-indirection", {
        sessionFile: "/s/done.jsonl",
        sessionId: "id-done",
      });

      const ctx = mockSpawnCtx(root, "sess-parent");
      const result = await subagentTool.execute(
        "call-1",
        { agent: "worker", name: "f1-indirection", task: "continue the work" },
        undefined,
        undefined,
        ctx,
      );

      assert.equal(result.details?.error, "name collision");
      assert.equal(result.details?.kind, "finished");
      assert.match(result.content[0].text, /already registered in this session/);
      assert.match(result.content[0].text, /\/s\/done\.jsonl/);
      assert.match(result.content[0].text, /subagent_message/);
      assert.equal(runningMap.size, 0);
    } finally {
      runningMap.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a spawn whose explicit name is reserved by an in-flight parallel spawn", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its explicit name before
      // it has registered in runningSubagents.
      reserved.add("dup");

      const result = await subagentTool.execute(
        "call-1",
        { agent: "worker", name: "dup", task: "second spawn" },
        undefined,
        undefined,
        mockSpawnCtx(),
      );

      assert.equal(result.details?.error, "name collision");
      assert.equal(result.details?.kind, "in-flight");
      assert.match(result.content[0].text, /claimed by another spawn/);
      assert.equal(runningMap.size, 0);
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("reports ambiguity instead of steering an arbitrary match for duplicate running names", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "499163e0", name: "f1-indirection", surface: "pane-a" }));
      runningMap.set("b2", makeRunning({ id: "d08d104d", name: "f1-indirection", surface: "pane-b" }));

      const result = await messageTool.execute(
        "call-1",
        { name: "f1-indirection", message: "continue" },
        undefined,
        undefined,
        mockSpawnCtx(),
      );

      // A raw first-match find would have "steered"; the guard reports both.
      assert.equal(result.details?.status, "ambiguous");
      assert.match(result.details?.error ?? "", /Ambiguous subagent name/);
      assert.match(result.content[0].text, /Ambiguous subagent name "f1-indirection"/);
      assert.match(result.content[0].text, /499163e0/);
      assert.match(result.content[0].text, /d08d104d/);
      // It must not have fallen through to the resume path either.
      assert.match(result.content[0].text, /Matches:/);
    } finally {
      runningMap.clear();
    }
  });

  it("still steers the single match when exactly one running subagent has the name", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const sent: Array<{ surface: string; message: string }> = [];
    const fakeBackend = {
      kind: "tmux",
      available: () => true,
      sendMessage: (surface: string, message: string) => sent.push({ surface, message }),
    } as any;

    try {
      __setBackendForTest__(fakeBackend);
      runningMap.set("a1", makeRunning({ id: "a1", name: "f1-indirection", surface: "pane-a" }));

      const result = await messageTool.execute(
        "call-1",
        { name: "f1-indirection", message: "continue the work" },
        undefined,
        undefined,
        mockSpawnCtx(),
      );

      assert.equal(result.details?.status, "steered");
      assert.deepEqual(sent, [{ surface: "pane-a", message: "continue the work" }]);
    } finally {
      __setBackendForTest__(null);
      runningMap.clear();
    }
  });

  it("registerName returns the replaced entry so the spawn can warn", () => {
    const dir = createTestDir();
    try {
      assert.equal(
        registerName(dir, "worker", { sessionFile: "/s/old.jsonl", sessionId: "id-old" }),
        null,
      );
      const replaced = registerName(dir, "worker", {
        sessionFile: "/s/new.jsonl",
        sessionId: "id-new",
      });
      assert.equal(replaced?.sessionFile, "/s/old.jsonl");
      assert.equal(resolveNameInRegistry(dir, "worker")?.sessionId, "id-new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("park-aware child task wrapper preamble", () => {
  const testApi = (subagentsModule as any).__test__;
  const { buildAutoExitModeHint, buildSummaryInstruction } = testApi;

  // Ungranted base strings — today's text verbatim. These are the regression
  // guard: the ungranted variants MUST stay byte-identical to the pre-change
  // strings (plan Step 1 item 2, Step 2 item 2).
  const AUTO_EXIT_MODE_HINT =
    "Complete your task autonomously. When you are finished, simply stop — your session ends automatically.";
  const INTERACTIVE_MODE_HINT =
    "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const AUTO_EXIT_SUMMARY = "Your FINAL assistant message should summarize what you accomplished.";
  const INTERACTIVE_SUMMARY =
    "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";

  // Park clause (plan Step 1 item 3) and interim-report paragraph (Step 2
  // item 1), de-wrapped from the 80-col plan to single-paragraph strings.
  // De-wrapped from the 80-col plan: the park clause is one contiguous
  // sentence; the interim paragraph has real line breaks between its three
  // sentences.
  const PARK_CLAUSE =
    "If you spawned subagents of your own, stopping does NOT end your session " +
    "while any of them is still running: the session stays parked, and each of " +
    "their results arrives as a new message that starts a continuation turn.";
  const INTERIM_PARAGRAPH =
    "Your final report is only delivered when the session actually ends.\n" +
    "Any summary you write while your own subagents are still running is NOT " +
    "delivered to the orchestrator — if you must summarize at that point, keep " +
    'it to a few lines and label it "interim report".\n' +
    "The real final report belongs in the turn that handles your last pending " +
    "result; make that message complete and self-contained.";

  describe("buildAutoExitModeHint", () => {
    it("autoExit && !grantSpawning: byte-identical to today's string (regression guard)", () => {
      assert.equal(typeof buildAutoExitModeHint, "function", "buildAutoExitModeHint must be exported");
      assert.equal(buildAutoExitModeHint(true, false), AUTO_EXIT_MODE_HINT);
    });

    it("autoExit && grantSpawning: park-aware variant ends in the park clause", () => {
      const hint = buildAutoExitModeHint(true, true);
      assert.ok(hint.startsWith("Complete your task autonomously. When you are finished, simply stop."));
      assert.ok(hint.includes(PARK_CLAUSE));
      assert.ok(hint.endsWith("a fresh task."));
      assert.ok(hint !== AUTO_EXIT_MODE_HINT, "granted auto-exit hint must differ from the ungranted string");
    });

    it("interactive && !grantSpawning: byte-identical to today's string (regression guard)", () => {
      assert.equal(buildAutoExitModeHint(false, false), INTERACTIVE_MODE_HINT);
    });

    it("interactive && grantSpawning: appends the one continuation sentence", () => {
      const hint = buildAutoExitModeHint(false, true);
      assert.ok(hint.startsWith(INTERACTIVE_MODE_HINT));
      assert.ok(hint.includes("keep processing them before considering the task finished."));
      assert.ok(hint !== INTERACTIVE_MODE_HINT, "granted interactive hint must differ from the ungranted string");
    });
  });

  describe("buildSummaryInstruction", () => {
    it("autoExit && !grantSpawning: byte-identical to today's string (regression guard)", () => {
      assert.equal(typeof buildSummaryInstruction, "function", "buildSummaryInstruction must be exported");
      assert.equal(buildSummaryInstruction(true, false), AUTO_EXIT_SUMMARY);
    });

    it("autoExit && grantSpawning: appends the interim-report paragraph", () => {
      const instr = buildSummaryInstruction(true, true);
      assert.ok(instr.startsWith(AUTO_EXIT_SUMMARY));
      assert.ok(instr.includes(INTERIM_PARAGRAPH));
      assert.ok(instr !== AUTO_EXIT_SUMMARY, "granted auto-exit summary must differ from the ungranted string");
    });

    it("interactive && !grantSpawning: byte-identical to today's string (regression guard)", () => {
      assert.equal(buildSummaryInstruction(false, false), INTERACTIVE_SUMMARY);
    });

    it("interactive && grantSpawning: appends the interim-report paragraph", () => {
      const instr = buildSummaryInstruction(false, true);
      assert.ok(instr.startsWith(INTERACTIVE_SUMMARY));
      assert.ok(instr.includes(INTERIM_PARAGRAPH));
    });
  });
});

describe("bash-guard-mode (per-agent guard modes)", () => {
  const testApi = (subagentsModule as any).__test__;

  // A loadable bash-guard extension directory: a dir (or symlink) whose
  // canonical basename is `bash-guard` and that pi can load (index.ts present).
  function makeGuardDir(dir: string): string {
    const guard = join(dir, "bash-guard");
    mkdirSync(guard, { recursive: true });
    writeFileSync(join(guard, "index.ts"), "export default (pi) => {};\n");
    return guard;
  }

  function spawnCtx(root: string, sessionId = "sess-bash-guard") {
    const sessionDir = join(root, "sessions");
    return {
      sessionManager: {
        getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: root,
    } as any;
  }

  // A multiplexer backend that records the long command sent to each surface
  // (the built pi/claude launch command) instead of talking to a real mux.
  function fakeBackend(sent: Array<{ surface: string; command: string }>) {
    return {
      kind: "tmux",
      available: () => true,
      createSurface: async (_name: string) => "fake-pane-1",
      createSurfaceTab: async () => "fake-tab-1",
      sendLongCommand: (surface: string, command: string) => {
        sent.push({ surface, command });
        return "fake-script.sh";
      },
      sendCommand: (surface: string, command: string) => {
        sent.push({ surface, command });
      },
      readScreen: () => "", // no __SUBAGENT_DONE__ sentinel, so watchers idle
      readScreenAsync: async () => "",
      closeSurface: () => {},
      labelSurface: () => {},
      sendMessage: () => {},
    } as any;
  }

  // Spawn via the registered `subagent` tool; returns { result, running }.
  // Uses a CAPTURING api so the extension's `session_shutdown` handler can be
  // fired after the launch returns, clearing the module-level widget/status
  // refresh intervals and aborting the fire-and-forget watcher - otherwise
  // those pending timers keep the node test process alive (hang).
  async function spawn(name: string, agent: string, ctx: any, sent: any[]) {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const tools: any[] = [];
    const api = {
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool(t: any) {
        tools.push(t);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    } as any;
    (subagentsModule as any).default(api);
    const tool = tools.find((t) => t.name === "subagent");
    const result = await tool.execute("call", { agent, name, task: "t" }, undefined, undefined, ctx);
    const running = Array.from((testApi.runningSubagents as Map<string, any>).values()).pop();
    // Tear down: fire session_shutdown to clear intervals + abort watchers.
    (handlers.get("session_shutdown") ?? []).forEach((h) => h());
    testApi.runningSubagents.clear();
    return { result, running };
  }

  describe("parseAgentDefinition (S1)", () => {
    it("parses bash-guard-mode to its raw (lowercased/trimmed) value", async () => {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "bgm-parse", "name: bgm-parse\nbash-guard-mode: read-only");
        const loaded = testApi.loadAgentDefaults("bgm-parse");
        assert.ok(loaded, "expected agent to load");
        assert.equal(loaded.bashGuardMode, "read-only");
        // sourceFile points at the file it was read from.
        assert.equal(loaded.sourceFile, join(globalAgentsDir, "bgm-parse.md"));
      });
    });

    it("lowercases and trims the raw value but does NOT validate at parse", async () => {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "bgm-parse-case", "name: bgm-parse-case\nbash-guard-mode:   READ-ONLY  ");
        const loaded = testApi.loadAgentDefaults("bgm-parse-case");
        assert.equal(loaded.bashGuardMode, "read-only", "expected lowercase-trim raw value");
      });
    });

    it("leaves bash-guard-mode undefined when the field is absent", async () => {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "bgm-absent", "name: bgm-absent\nmodel: anthropic/x");
        const loaded = testApi.loadAgentDefaults("bgm-absent");
        assert.ok(loaded);
        assert.equal(loaded.bashGuardMode, undefined);
      });
    });

    it("parses bad values (readonly/ro/empty) LENIENTLY without throwing", async () => {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        for (const [name, value] of [
          ["bgm-bad-ro", "readonly"],
          ["bgm-bad-ro2", "ro"],
          ["bgm-bad-empty", ""],
          ["bgm-bad-word", "BASH-ONLY"],
        ] as const) {
          writeAgentFile(globalAgentsDir, name, `name: ${name}\nbash-guard-mode: ${value}`);
          // Must not throw (discovery must stay healthy); stored raw.
          const loaded = testApi.loadAgentDefaults(name);
          assert.ok(loaded, `expected ${name} to load`);
        }
        assert.equal(testApi.loadAgentDefaults("bgm-bad-ro").bashGuardMode, "readonly");
        assert.equal(testApi.loadAgentDefaults("bgm-bad-ro2").bashGuardMode, "ro");
        // Empty value normalizes to absent (undefined), not the empty string.
        assert.equal(testApi.loadAgentDefaults("bgm-bad-empty").bashGuardMode, undefined);
        assert.equal(testApi.loadAgentDefaults("bgm-bad-word").bashGuardMode, "bash-only");
      });
    });
  });

  it("validateBashGuardMode: invalid mode names raw value and source file; valid/absent pass", () => {
    // Invalid: names the raw value AND the source file.
    assert.equal(
      testApi.validateBashGuardMode("scout", "readonly", "/agents/scout.md"),
      "agent scout has invalid bash-guard-mode 'readonly' " +
        "(expected off, prompt, floor, or read-only) in /agents/scout.md",
    );
    // Valid modes pass.
    for (const m of ["off", "prompt", "floor", "read-only"]) {
      assert.equal(testApi.validateBashGuardMode("scout", m, "/f"), null);
    }
    // Absent (undefined) or null pass.
    assert.equal(testApi.validateBashGuardMode("scout", undefined, "/f"), null);
    assert.equal(testApi.validateBashGuardMode("scout", null, "/f"), null);
  });

  it("discovery keeps an agent with a bad bash-guard-mode and warns once per session", async () => {
    const origWarn = console.warn;
    const warned: string[] = [];
    console.warn = (m: unknown) => warned.push(String(m));
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "bgm-disc", "name: bgm-disc\nbash-guard-mode: readonly");
        // Discovery must NOT crash on the bad value.
        const agents = testApi.discoverAgentDefinitions();
        const found = agents.find((a: any) => a.name === "bgm-disc");
        assert.ok(found, "expected the bad-mode agent to still be listed");
        assert.equal(found.bashGuardMode, "readonly");
        // Exactly one warning for this (agent, file, value) per session.
        assert.equal(warned.filter((w) => w.includes("bgm-disc")).length, 1);
        assert.match(warned.find((w) => w.includes("bgm-disc")) ?? "", /invalid bash-guard-mode 'readonly'/);
        // A second discovery does not re-warn for the same agent/file/value.
        testApi.discoverAgentDefinitions();
        assert.equal(warned.filter((w) => w.includes("bgm-disc")).length, 1);
      });
    } finally {
      console.warn = origWarn;
    }
  });

  describe("S4 fail-closed spawn guard", () => {
    function setup(root: string) {
      const sent: Array<{ surface: string; command: string }> = [];
      __setBackendForTest__(fakeBackend(sent));
      const ctx = spawnCtx(root);
      // A valid session file (the resume guard checks existsSync only).
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
      return { sent, ctx };
    }

    afterEach(() => {
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
    });

    it("S1: rejects an invalid bash-guard-mode at spawn, naming the raw value and source file", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          const src = join(globalAgentsDir, "bgm-invalid.md");
          writeAgentFile(globalAgentsDir, "bgm-invalid", "name: bgm-invalid\nbash-guard-mode: readonly");
          // A valid mode (for contrast) passes the S1 check.
          writeAgentFile(globalAgentsDir, "bgm-valid", "name: bgm-valid\nbash-guard-mode: off");

          // Invalid mode: the spawn rejects, naming the raw value and the file.
          await assert.rejects(
            spawn("bgm-invalid", "bgm-invalid", spawnCtx(root), sent),
            new RegExp(
              `agent bgm-invalid has invalid bash-guard-mode 'readonly' ` +
                `\\(expected off, prompt, floor, or read-only\\) in ${src}`,
            ),
          );

          // A valid mode passes the S1 check (proceeds; off needs no guard).
          const ok = await spawn("bgm-valid", "bgm-valid", spawnCtx(root), sent);
          assert.equal(ok.result.details?.status, "started", ok.result.content[0].text);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(d) rejects a guard-requiring mode on a cli:claude agent (pi CLI required)", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(
            globalAgentsDir,
            "bgm-claude",
            "name: bgm-claude\ncli: claude\nbash-guard-mode: read-only",
          );
          // The spawn rejects (no clean tool result): the guard is a pi extension.
          await assert.rejects(
            spawn("bgm-claude", "bgm-claude", spawnCtx(root), sent),
            /bash-guard-mode requires the pi CLI/,
          );
          // No command was sent: the child never starts.
          assert.equal(sent.length, 0, "no launch command should be sent");
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(a) rejects a guard-requiring mode when no always-on extensions resolve (guard missing)", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(
            globalAgentsDir,
            "bgm-noguard",
            "name: bgm-noguard\nbash-guard-mode: read-only\ntools: read, bash",
          );
          await assert.rejects(
            spawn("bgm-noguard", "bgm-noguard", ctx, sent),
            /not in the resolved always-on extensions/,
          );
          assert.equal(sent.length, 0);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(b) still rejects when a DIFFERENT always-on extension is present but bash-guard is not", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      // A loadable extension that is NOT bash-guard.
      const otherExt = join(root, "some-other-ext");
      mkdirSync(otherExt, { recursive: true });
      writeFileSync(join(otherExt, "index.ts"), "export default (pi) => {};\n");
      testApi.__setAlwaysOnExtensionsConfigForTest([otherExt]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(
            globalAgentsDir,
            "bgm-otherext",
            "name: bgm-otherext\nbash-guard-mode: read-only",
          );
          // The other extension is present, but bash-guard is not: still refuse.
          await assert.rejects(
            spawn("bgm-otherext", "bgm-otherext", ctx, sent),
            /not in the resolved always-on extensions/,
          );
          assert.equal(sent.length, 0);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(c) proceeds when a resolvable path whose basename is `bash-guard` is present", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      const guard = makeGuardDir(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([guard]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(
            globalAgentsDir,
            "bgm-ok",
            "name: bgm-ok\nbash-guard-mode: read-only\ntools: read, bash",
          );
          const { result } = await spawn("bgm-ok", "bgm-ok", ctx, sent);
          assert.equal(result.details?.status, "started", result.content[0].text);
          assert.equal(sent.length, 1);
          assert.match(sent[0].command, /PI_BASH_GUARD_MODE='read-only'/);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(e) mode off with an empty always-on set proceeds (off means unguarded by definition)", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(globalAgentsDir, "bgm-off", "name: bgm-off\nbash-guard-mode: off");
          const { result } = await spawn("bgm-off", "bgm-off", ctx, sent);
          assert.equal(result.details?.status, "started", result.content[0].text);
          assert.equal(sent.length, 1);
          assert.match(sent[0].command, /PI_BASH_GUARD_MODE='off'/);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(f) proceeds + warns when bash-guard resolves but a `-` exclusion is also present", async () => {
      const root = createTestDir();
      const origWarn = console.warn;
      const warned: string[] = [];
      console.warn = (m: unknown) => warned.push(String(m));
      const { sent, ctx } = setup(root);
      const guard = makeGuardDir(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([guard]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          // bash-guard (config) + a `-` exclusion that matches nothing.
          writeAgentFile(
            globalAgentsDir,
            "bgm-excl",
            `name: bgm-excl\nbash-guard-mode: read-only\nalways-on-extensions: -${join(root, "not-present")}`,
          );
          const { result } = await spawn("bgm-excl", "bgm-excl", ctx, sent);
          assert.equal(result.details?.status, "started", result.content[0].text);
          assert.equal(sent.length, 1);
          // The exclusion warning is emitted (bash-guard survived, user must confirm).
          assert.ok(
            warned.some((w) => w.includes("bgm-excl") && /exclusion/.test(w)),
            `expected a bash-guard exclusion warning, got: ${JSON.stringify(warned)}`,
          );
        });
      } finally {
        console.warn = origWarn;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("S2 loadout snapshot (resume-safe)", () => {
    it("spawn-side loadout contains bashGuardMode; a pre-field snapshot reads back as null", () => {
      const dir = createTestDir();
      try {
        const sf = join(dir, "s.jsonl");
        const full: any = {
          agent: "scout",
          toolAllowlist: "read,bash,ask_question",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: null,
          bashGuardMode: "read-only",
          autoExit: true,
          cwd: null,
          agentDir: null,
        };
        writeSubagentLoadout(sf, full);
        assert.equal(readSubagentLoadout(sf)!.bashGuardMode, "read-only");

        // A snapshot written before the field existed simply lacks the key;
        // readSubagentLoadout returns it as-is, so it must be treated as null.
        const sf2 = join(dir, "old.jsonl");
        const old: any = {
          agent: "scout",
          toolAllowlist: "read,write,ask_question",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          alwaysOnExtensions: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        };
        writeSubagentLoadout(sf2, old);
        const loadedOld = readSubagentLoadout(sf2)!;
        assert.equal(loadedOld.bashGuardMode, undefined, "pre-field snapshot lacks the key");
        // resume treats missing as null → emits no env.
        assert.equal(testApi.bashGuardModeEnvPart(loadedOld.bashGuardMode ?? null), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("S2 env emission on spawn and resume", () => {
    function setup(root: string) {
      const sent: Array<{ surface: string; command: string }> = [];
      __setBackendForTest__(fakeBackend(sent));
      const ctx = spawnCtx(root);
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
      return { sent, ctx };
    }
    afterEach(() => {
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
    });

    it("spawn: agent with bash-guard-mode emits PI_BASH_GUARD_MODE; without it, the var is absent", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      const guard = makeGuardDir(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([guard]);
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(globalAgentsDir, "bgm-env-on", "name: bgm-env-on\nbash-guard-mode: read-only\ntools: read, bash");
          writeAgentFile(globalAgentsDir, "bgm-env-off", "name: bgm-env-off\ntools: read, bash");

          const on = await spawn("bgm-env-on", "bgm-env-on", ctx, sent);
          assert.equal(on.result.details?.status, "started");
          const onCmd = sent[sent.length - 1].command;
          assert.match(onCmd, /PI_BASH_GUARD_MODE='read-only'/);

          const off = await spawn("bgm-env-off", "bgm-env-off", ctx, sent);
          assert.equal(off.result.details?.status, "started");
          const offCmd = sent[sent.length - 1].command;
          assert.doesNotMatch(offCmd, /PI_BASH_GUARD_MODE/);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("resume: replays PI_BASH_GUARD_MODE from the snapshot; a pre-field snapshot emits none", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      const guard = makeGuardDir(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([guard]);
      try {
        // Register two finished subagents in THIS spawner's registry.
        const adir = join(ctx.sessionManager.getSessionDir(), "artifacts", "sess-bash-guard");
        const sfNew = join(root, "new.jsonl");
        const sfOld = join(root, "old.jsonl");
        for (const sf of [sfNew, sfOld]) {
          writeFileSync(sf, JSON.stringify(SESSION_HEADER) + "\n");
        }
        registerName(adir, "bgm-resume", { sessionFile: sfNew, sessionId: "id-new" });
        registerName(adir, "bgm-resume-old", { sessionFile: sfOld, sessionId: "id-old" });

        // New snapshot carries the mode; the old one lacks the key.
        writeSubagentLoadout(sfNew, {
          agent: "bgm-resume", toolAllowlist: "read,bash,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          bashGuardMode: "read-only", autoExit: true, cwd: null, agentDir: null,
        } as any);
        writeSubagentLoadout(sfOld, {
          agent: "bgm-resume-old", toolAllowlist: "read,write,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          autoExit: true, cwd: null, agentDir: null,
        } as any);

        // A capturing api so we can fire session_shutdown after each resume
        // (clears the module-level refresh intervals and aborts the watchers).
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        const tools: any[] = [];
        const api = {
          on(event: string, handler: (...args: any[]) => void) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event)!.push(handler);
          },
          registerTool(t: any) { tools.push(t); },
          registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
          sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
        } as any;
        (subagentsModule as any).default(api);
        const tool = tools.find((t) => t.name === "subagent_message");
        const shutdown = () => (handlers.get("session_shutdown") ?? []).forEach((h) => h());

        const r1 = await tool.execute("c1", { name: "bgm-resume", message: "continue" }, undefined, undefined, ctx);
        assert.equal(r1.details?.status, "started", r1.content[0].text);
        const newCmd = sent[sent.length - 1].command;
        assert.match(newCmd, /PI_BASH_GUARD_MODE='read-only'/);
        shutdown();
        testApi.runningSubagents.clear();

        const r2 = await tool.execute("c2", { name: "bgm-resume-old", message: "continue" }, undefined, undefined, ctx);
        assert.equal(r2.details?.status, "started", r2.content[0].text);
        const oldCmd = sent[sent.length - 1].command;
        assert.doesNotMatch(oldCmd, /PI_BASH_GUARD_MODE/);
        shutdown();
        testApi.runningSubagents.clear();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("S4 fail-closed re-check + mode validation on RESUME", () => {
    function setup(root: string) {
      const sent: Array<{ surface: string; command: string }> = [];
      __setBackendForTest__(fakeBackend(sent));
      const ctx = spawnCtx(root);
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
      return { sent, ctx };
    }
    afterEach(() => {
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
    });

    // Build a capturing subagent_message api + the registry/loadout fixtures,
    // mirroring the S2 resume test so each case registers one finished
    // subagent with a given loadout and a given always-on config.
    async function buildResume(
      root: string,
      name: string,
      loadout: any,
    ) {
      const adir = join(spawnCtx(root).sessionManager.getSessionDir(), "artifacts", "sess-bash-guard");
      const sf = join(root, `${name}.jsonl`);
      writeFileSync(sf, JSON.stringify(SESSION_HEADER) + "\n");
      registerName(adir, name, { sessionFile: sf, sessionId: `id-${name}` });
      writeSubagentLoadout(sf, loadout);

      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      (subagentsModule as any).default(api);
      const tool = tools.find((t) => t.name === "subagent_message");
      const shutdown = () => (handlers.get("session_shutdown") ?? []).forEach((h) => h());
      return { sf, tool, ctx: spawnCtx(root), shutdown };
    }

    it("resumes a read-only snapshot while the guard is resolvable (proceeds, env present)", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      const guard = makeGuardDir(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([guard]);
      try {
        const { sf, tool, ctx, shutdown } = await buildResume(root, "r-ok", {
          agent: "r-ok", toolAllowlist: "read,bash,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          bashGuardMode: "read-only", cli: null, autoExit: true, cwd: null, agentDir: null,
        });
        const r = await tool.execute("c1", { name: "r-ok", message: "continue" }, undefined, undefined, ctx);
        assert.equal(r.details?.status, "started", r.content[0].text);
        assert.match(sent[sent.length - 1].command, /PI_BASH_GUARD_MODE='read-only'/);
        shutdown();
        testApi.runningSubagents.clear();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses a read-only snapshot when the guard is no longer resolvable (guard removed from config)", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      // The guard existed at spawn, but is now GONE from the always-on config.
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const { tool, ctx } = await buildResume(root, "r-noguard", {
          agent: "r-noguard", toolAllowlist: "read,bash,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          bashGuardMode: "read-only", cli: null, autoExit: true, cwd: null, agentDir: null,
        });
        const r = await tool.execute("c1", { name: "r-noguard", message: "continue" }, undefined, undefined, ctx);
        assert.notEqual(r.details?.status, "started");
        assert.match(r.content[0].text, /bash-guard is not in the resolved always-on extensions/);
        assert.equal(sent.length, 0, "no child command must be built/sent");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses a snapshot with a hand-edited invalid bashGuardMode, naming the loadout file", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const { sf, tool, ctx } = await buildResume(root, "r-badmode", {
          agent: "r-badmode", toolAllowlist: "read,bash,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          bashGuardMode: "ro", cli: null, autoExit: true, cwd: null, agentDir: null,
        });
        const r = await tool.execute("c1", { name: "r-badmode", message: "continue" }, undefined, undefined, ctx);
        assert.notEqual(r.details?.status, "started");
        // Names the raw bad value AND the loadout sidecar file path.
        assert.match(r.content[0].text, /'ro'/);
        assert.match(r.content[0].text, new RegExp(sf.replace(/[\\/]/g, "[\\/]") + ".loadout.json"));
        assert.equal(sent.length, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("resumes a mode-off snapshot with an empty always-on set (no check, no env)", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const { tool, ctx, shutdown } = await buildResume(root, "r-off", {
          agent: "r-off", toolAllowlist: "read,bash,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          bashGuardMode: "off", cli: null, autoExit: true, cwd: null, agentDir: null,
        });
        const r = await tool.execute("c1", { name: "r-off", message: "continue" }, undefined, undefined, ctx);
        assert.equal(r.details?.status, "started", r.content[0].text);
        assert.match(sent[sent.length - 1].command, /PI_BASH_GUARD_MODE='off'/);
        shutdown();
        testApi.runningSubagents.clear();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("resumes an old snapshot (no bashGuardMode key, no cli) exactly as before: no env, no check", async () => {
      const root = createTestDir();
      const { sent } = setup(root);
      // No guard configured AND no always-on extensions: if the resume had
      // (wrongly) applied the S4 check, an old snapshot with a mode would fail.
      // It must resume unguarded, exactly as pre-change behavior.
      testApi.__setAlwaysOnExtensionsConfigForTest([]);
      try {
        const { tool, ctx, shutdown } = await buildResume(root, "r-legacy", {
          agent: "r-legacy", toolAllowlist: "read,write,ask_question", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null, alwaysOnExtensions: null,
          // No bashGuardMode key AND no cli key: a pre-field snapshot.
          autoExit: true, cwd: null, agentDir: null,
        });
        const r = await tool.execute("c1", { name: "r-legacy", message: "continue" }, undefined, undefined, ctx);
        assert.equal(r.details?.status, "started", r.content[0].text);
        assert.doesNotMatch(sent[sent.length - 1].command, /PI_BASH_GUARD_MODE/);
        shutdown();
        testApi.runningSubagents.clear();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("extension-alone health (no hard bash-guard dependency)", () => {
    function setup(root: string) {
      const sent: Array<{ surface: string; command: string }> = [];
      __setBackendForTest__(fakeBackend(sent));
      const ctx = spawnCtx(root);
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
      return { sent, ctx };
    }
    afterEach(() => {
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
    });

    it("a mode-less agent and an off-mode agent proceed with NO always-on extensions configured", async () => {
      const root = createTestDir();
      const { sent, ctx } = setup(root);
      testApi.__setAlwaysOnExtensionsConfigForTest([]); // bash-guard-not-installed world
      try {
        await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
          writeAgentFile(globalAgentsDir, "bgm-plain", "name: bgm-plain\ntools: read, bash");
          writeAgentFile(globalAgentsDir, "bgm-off2", "name: bgm-off2\nbash-guard-mode: off");
          const a = await spawn("bgm-plain", "bgm-plain", ctx, sent);
          assert.equal(a.result.details?.status, "started", a.result.content[0].text);
          const b = await spawn("bgm-off2", "bgm-off2", ctx, sent);
          assert.equal(b.result.details?.status, "started", b.result.content[0].text);
          assert.equal(sent.length, 2);
          assert.doesNotMatch(sent[0].command, /PI_BASH_GUARD_MODE/);
          assert.match(sent[1].command, /PI_BASH_GUARD_MODE='off'/);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // S3: `bash` is a built-in tool - no backing extension, so a loadout with
  // `bash` in the allowlist must not add any `-e` file for it.
  it("S3: bash is a built-in - no tool-extension path and no -e file added for it", () => {
    const d = createTestDir();
    // Hermetic: the assertion is "no -e file backs the built-in bash tool".
    // The host config.json now ships a bash-guard path (which matches /bash/),
    // so pin the always-on set to empty via the test hook rather than
    // depending on whatever the machine has installed.
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    try {
      assert.equal(testApi.getToolExtensionPath("bash"), undefined);
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "scout", toolAllowlist: "read,grep,find,ls,bash,ask_question", model: null,
          thinking: null, systemPromptMode: null, identity: null, spawnable: null,
          alwaysOnExtensions: null, autoExit: true, cwd: null, agentDir: null,
        },
        { artifactDir: d, name: "scout" },
      );
      const eValues = parts
        .map((p, i) => (p === "-e" ? parts[i + 1] : null))
        .filter((p): p is string => p !== null);
      assert.ok(eValues.length >= 0);
      // No extension file is added to back the built-in bash tool.
      assert.ok(
        !eValues.some((v) => /bash/.test(v)),
        `expected no -e file for the built-in bash tool, got: ${JSON.stringify(eValues)}`,
      );
    } finally {
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(d, { recursive: true, force: true });
    }
  });

  // S7 Phase 2: `safe_bash` was REMOVED (replaced by `bash` +
  // `bash-guard-mode`). A spawn whose child tools still list the stale name
  // must warn ONCE per session; a second spawn in the same session must not
  // re-warn. The spawn itself proceeds (the name is now a no-op tool).
  it("S7: warns once per session when the child tools list safe_bash (removed)", async () => {
    const origWarn = console.warn;
    const warned: string[] = [];
    console.warn = (m: unknown) => warned.push(String(m));
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    __setBackendForTest__(fakeBackend(sent));
    const ctx = spawnCtx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    const expectedWarning = "safe_bash was removed; use bash + bash-guard-mode (see README)";
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        // Two agents with the stale safe_bash tool: the first spawn warns,
        // the second (a different agent) must NOT warn again - once per
        // session, not per agent.
        writeAgentFile(globalAgentsDir, "s7-legacy-a", "name: s7-legacy-a\ntools: read, safe_bash");
        writeAgentFile(globalAgentsDir, "s7-legacy-b", "name: s7-legacy-b\ntools: read, safe_bash");

        const a = await spawn("s7-legacy-a", "s7-legacy-a", ctx, sent);
        assert.equal(a.result.details?.status, "started", a.result.content[0].text);
        assert.equal(warned.filter((w) => w.includes(expectedWarning)).length, 1);

        const b = await spawn("s7-legacy-b", "s7-legacy-b", ctx, sent);
        assert.equal(b.result.details?.status, "started", b.result.content[0].text);
        // Still exactly one warning after the second spawn.
        assert.equal(warned.filter((w) => w.includes(expectedWarning)).length, 1);
        assert.equal(sent.length, 2);
      });
    } finally {
      console.warn = origWarn;
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("model-fallback (S3 one-shot model fallback)", () => {
  const testApi = (subagentsModule as any).__test__;

  // Mock spawner context: the parent's LIVE model/thinking (the `inherit`
  // source) plus the session-manager shape launchSubagent needs.
  function s3Ctx(root: string, sessionId = "sess-s3") {
    const sessionDir = join(root, "sessions");
    return {
      sessionManager: {
        getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: root,
      model: { provider: "litellm", id: "coding" },
      thinkingLevel: "medium",
    } as any;
  }

  // Fake backend with GATED exits: every created surface starts "running"
  // (no sentinel on screen) until the test releases it. Gates are created at
  // surface-creation time (index = order of creation) so releases are race-free.
  function s3GatedBackend(sent: Array<{ surface: string; command: string }>, created: string[]) {
    const gates: Array<{ exitCode: number; released: boolean }> = [];
    const newSurface = (kind: string) => {
      const s = `${kind}-${gates.length + 1}`;
      gates.push({ exitCode: 0, released: false });
      created.push(s);
      return s;
    };
    return {
      backend: {
        kind: "tmux",
        available: () => true,
        createSurface: async () => newSurface("s3-pane"),
        createSurfaceTab: async () => newSurface("s3-tab"),
        sendLongCommand: (surface: string, command: string) => {
          sent.push({ surface, command });
          return `${surface}.sh`;
        },
        sendCommand: (surface: string, command: string) => sent.push({ surface, command }),
        readScreen: () => "",
        readScreenAsync: async (surface: string) => {
          const g = gates[created.indexOf(surface)];
          return g?.released ? `__SUBAGENT_DONE_${g.exitCode}__` : "";
        },
        closeSurface: () => {},
        labelSurface: () => {},
        sendMessage: () => {},
      } as any,
      setExit(index: number, exitCode: number) {
        gates[index - 1].exitCode = exitCode;
      },
      release(index: number) {
        gates[index - 1].released = true;
      },
    };
  }

  // Spawn via the registered `subagent` tool with a capturing api. Returns the
  // tool result plus the teardown (fire session_shutdown to clear intervals
  // and abort watchers — call it ONLY after the run under test has settled).
  async function s3Spawn(name: string, agent: string, ctx: any, sent: any[]) {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const tools: any[] = [];
    const sentMessages: any[] = [];
    const api = {
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool(t: any) {
        tools.push(t);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage(m: any) {
        sentMessages.push(m);
      },
      getAllTools() {
        return [];
      },
    } as any;
    (subagentsModule as any).default(api);
    const tool = tools.find((t: any) => t.name === "subagent");
    // Fire session_start FIRST: the module installs a fresh abort controller
    // there (a prior test's session_shutdown aborts the shared one, which would
    // otherwise abort this spawn's fire-and-forget watcher instantly).
    (handlers.get("session_start") ?? []).forEach((h) => h({}, ctx));
    const result = await tool.execute("call", { agent, name, task: "task body" }, undefined, undefined, ctx);
    const teardown = () => {
      (handlers.get("session_shutdown") ?? []).forEach((h) => h());
      testApi.runningSubagents.clear();
    };
    return { result, sentMessages, teardown };
  }

  async function waitForSubagentResult(
    sentMessages: any[],
    name: string,
    predicate?: (details: any) => boolean,
    timeoutMs = 60_000,
  ): Promise<any> {
    const start = Date.now();
    for (;;) {
      const found = sentMessages.find(
        (m) => m.customType === "subagent_result" && m.details?.name === name && (!predicate || predicate(m.details)),
      );
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for subagent_result for ${name}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── frontmatter parse ──

  it("parses model-fallback: inherit, concrete, and :thinking forms; absent is undefined", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(globalAgentsDir, "mf-inherit", "name: mf-inherit\nmodel-fallback: inherit");
      writeAgentFile(globalAgentsDir, "mf-concrete", "name: mf-concrete\nmodel-fallback: litellm/coding");
      writeAgentFile(globalAgentsDir, "mf-thinking", "name: mf-thinking\nmodel-fallback: litellm/coding:high");
      writeAgentFile(globalAgentsDir, "mf-absent", "name: mf-absent\nmodel: litellm/coding");
      assert.equal(testApi.loadAgentDefaults("mf-inherit").modelFallback, "inherit");
      assert.equal(testApi.loadAgentDefaults("mf-concrete").modelFallback, "litellm/coding");
      assert.equal(testApi.loadAgentDefaults("mf-thinking").modelFallback, "litellm/coding:high");
      assert.equal(testApi.loadAgentDefaults("mf-absent").modelFallback, undefined);
    });
  });

  // ── validation ──

  it("validateModelFallback: valid/absent pass, invalid names raw value and source file", () => {
    assert.equal(testApi.validateModelFallback("scout", "inherit", "/f"), null);
    assert.equal(testApi.validateModelFallback("scout", "INHERIT", "/f"), null);
    assert.equal(testApi.validateModelFallback("scout", "litellm/coding", "/f"), null);
    assert.equal(testApi.validateModelFallback("scout", "litellm/coding:high", "/f"), null);
    assert.equal(testApi.validateModelFallback("scout", undefined, "/f"), null);
    assert.equal(testApi.validateModelFallback("scout", null, "/f"), null);
    // Invalid shapes name the raw value AND the source file (bash-guard pattern).
    for (const bad of ["nonsense", "just-a-model", "provider/:high", "litellm/coding:off", "no-slash", "litellm/coding: "]) {
      const err = testApi.validateModelFallback("scout", bad, "/agents/scout.md");
      assert.equal(
        err,
        `agent scout has invalid model-fallback '${bad}' ` +
          "(expected 'inherit' or 'provider/model[:thinking]') in /agents/scout.md",
        `expected '${bad}' to be invalid`,
      );
    }
  });

  it("discovery keeps an agent with a bad model-fallback and warns once per session", async () => {
    const origWarn = console.warn;
    const warned: string[] = [];
    console.warn = (m: unknown) => warned.push(String(m));
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "mf-disc", "name: mf-disc\nmodel-fallback: nonsense");
        // Discovery must NOT crash on the bad value.
        const agents = testApi.discoverAgentDefinitions();
        const found = agents.find((a: any) => a.name === "mf-disc");
        assert.ok(found, "the bad-fallback agent must still be listed");
        assert.equal(found.modelFallback, "nonsense");
        assert.equal(warned.filter((w) => w.includes("mf-disc")).length, 1);
        assert.match(warned.find((w) => w.includes("mf-disc")) ?? "", /invalid model-fallback 'nonsense'/);
        // Second discovery does not re-warn.
        testApi.discoverAgentDefinitions();
        assert.equal(warned.filter((w) => w.includes("mf-disc")).length, 1);
      });
    } finally {
      console.warn = origWarn;
    }
  });

  it("rejects an invalid model-fallback at spawn, naming the raw value and source file", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const gated = s3GatedBackend(sent, created);
    __setBackendForTest__(gated.backend);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        const src = join(globalAgentsDir, "mf-invalid.md");
        writeAgentFile(globalAgentsDir, "mf-invalid", "name: mf-invalid\nmodel-fallback: nonsense-value");
        // A valid fallback (for contrast) would pass this check.
        writeAgentFile(globalAgentsDir, "mf-valid", "name: mf-valid\nmodel-fallback: litellm/coding");

        await assert.rejects(
          s3Spawn("mf-invalid", "mf-invalid", ctx, sent),
          new RegExp(
            `agent mf-invalid has invalid model-fallback 'nonsense-value' ` +
              `\\(expected 'inherit' or 'provider/model\\[:thinking\\]'\\) in ${src}`,
          ),
        );
        // Fail-closed BEFORE any surface or command: nothing was launched.
        assert.equal(sent.length, 0);
        assert.equal(created.length, 0);
      });
    } finally {
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── split / resolve ──

  it("splitModelThinking: provider/model and :thinking shapes", () => {
    assert.deepEqual(testApi.splitModelThinking("litellm/coding"), { model: "litellm/coding" });
    assert.deepEqual(testApi.splitModelThinking("litellm/coding:high"), { model: "litellm/coding", thinking: "high" });
    assert.deepEqual(testApi.splitModelThinking(" a/b : LOW "), { model: "a/b", thinking: "low" });
    assert.equal(testApi.splitModelThinking("no-slash"), null);
    assert.equal(testApi.splitModelThinking("litellm/coding:off"), null, "'off' is not a level");
    assert.equal(testApi.splitModelThinking("litellm/coding:"), null);
    assert.equal(testApi.splitModelThinking(""), null);
  });

  it("resolveParentModelDefaults reads the spawner's live model and thinking (mocked context)", () => {
    const parent = testApi.resolveParentModelDefaults({
      model: { provider: "litellm", id: "coding" },
      thinkingLevel: "medium",
    } as any);
    assert.equal(parent.model, "litellm/coding");
    assert.equal(parent.thinking, "medium");
    // No live model / no level (headless-ish context) → both undefined.
    const empty = testApi.resolveParentModelDefaults({} as any);
    assert.equal(empty.model, undefined);
    assert.equal(empty.thinking, undefined);
    // A model missing one half is treated as absent (not a partial id).
    const partial = testApi.resolveParentModelDefaults({ model: { provider: "litellm" } } as any);
    assert.equal(partial.model, undefined);
  });

  it("inherit resolves to the spawner's live model, with thinking precedence primary > parent > spec", () => {
    const parent = { model: "litellm/coding", thinking: "medium" };
    const noModel = { model: "litellm/other" };
    // inherit: model from the spawner's live model (NOT the primary's).
    let fb = testApi.resolveFallbackModelAndThinking(
      { agent: "a", task: "t" },
      { model: "litellm/primary", thinking: "high", modelFallback: "inherit" },
      parent,
      { model: "litellm/primary", thinking: "high" },
    );
    assert.deepEqual(fb, { model: "litellm/coding", thinking: "high" }); // primary thinking wins
    fb = testApi.resolveFallbackModelAndThinking(
      { agent: "a", task: "t" },
      { model: "litellm/primary", modelFallback: "inherit" },
      parent,
      { model: "litellm/primary" },
    );
    assert.deepEqual(fb, { model: "litellm/coding", thinking: "medium" }); // parent thinking
    // A concrete spec's own :thinking is the LAST resort.
    fb = testApi.resolveFallbackModelAndThinking(
      { agent: "a", task: "t" },
      { modelFallback: "litellm/fb:low" },
      noModel,
      {},
    );
    assert.deepEqual(fb, { model: "litellm/fb", thinking: "low" });
    // Spawner with no live model: inherit yields no model → no retry possible.
    fb = testApi.resolveFallbackModelAndThinking(
      { agent: "a", task: "t" },
      { modelFallback: "inherit" },
      {},
      { model: "litellm/primary" },
    );
    assert.equal(fb, undefined);
    // Absent field → undefined (no fallback configured).
    assert.equal(
      testApi.resolveFallbackModelAndThinking({ agent: "a", task: "t" }, { model: "litellm/x" }, parent, { model: "litellm/x" }),
      undefined,
    );
  });

  // ── shouldRetryWithFallback truth table ──

  it("shouldRetryWithFallback: truth table", () => {
    const S = testApi.shouldRetryWithFallback;
    // Clean success: no retry.
    assert.equal(S({ exitCode: 0, hasAssistantText: true }).retry, false);
    // Provider/agent error message: retry.
    assert.equal(S({ exitCode: 1, errorMessage: "boom", hasAssistantText: false }).retry, true);
    // Non-zero exit (no error message): retry.
    assert.equal(S({ exitCode: 2, hasAssistantText: true }).retry, true);
    // Zero exit but NO assistant text: retry.
    assert.equal(S({ exitCode: 0, hasAssistantText: false }).retry, true);
    // hasAssistantText unknown (undefined) is NOT a trigger.
    assert.equal(S({ exitCode: 0, hasAssistantText: undefined }).retry, false);
    // S2 interruption NEVER retries, even with a provider error + non-zero exit.
    assert.equal(S({ exitCode: 1, errorMessage: "boom", hasAssistantText: false, interrupted: true }).retry, false);
    // Legacy cancelled error never retries.
    assert.equal(S({ error: "cancelled", exitCode: 1 }).retry, false);
    // Interrupted + cancelled together: still no.
    assert.equal(S({ error: "cancelled", interrupted: true }).retry, false);
  });

  // ── same-model skip ──

  it("sameModelSelection compares model AND effective thinking (undefined === off)", () => {
    const S = testApi.sameModelSelection;
    assert.equal(S({ model: "a/b", thinking: "high" }, { model: "a/b", thinking: "high" }), true);
    assert.equal(S({ model: "a/b" }, { model: "a/b" }), true, "both undefined === same (off)");
    assert.equal(S({ model: "a/b", thinking: "high" }, { model: "a/b" }), false, "different level");
    assert.equal(S({ model: "a/b", thinking: "HIGH" }, { model: "a/b", thinking: "high" }), true, "case-insensitive");
    assert.equal(S({ model: "a/b", thinking: "high" }, { model: "a/c", thinking: "high" }), false, "different model");
    assert.equal(S({}, { model: "a/b" }), false);
  });

  it("fallbackDecision: skips a same-model+thinking retry (and only that)", () => {
    const D = testApi.fallbackDecision;
    // Trigger fired (exit 1, no text) but fallback == primary → skip, no attribution.
    let d = D({ exitCode: 1, hasAssistantText: false } as any, { model: "litellm/coding", thinking: "high" }, { model: "litellm/coding", thinking: "high" });
    assert.deepEqual(d, { retry: false, skippedSameSelection: true });
    // Different thinking → retry with attribution.
    d = D({ exitCode: 1, hasAssistantText: false } as any, { model: "litellm/coding", thinking: "low" }, { model: "litellm/coding", thinking: "high" });
    assert.equal(d.retry, true);
    assert.equal(d.attribution?.to, "litellm/coding");
    assert.equal(d.attribution?.from, "litellm/coding");
    // Different model → retry.
    d = D({ errorMessage: "boom" } as any, { model: "litellm/fb" }, { model: "litellm/primary" });
    assert.equal(d.retry, true);
    assert.equal(d.attribution?.from, "litellm/primary");
    assert.equal(d.attribution?.to, "litellm/fb");
    assert.match(d.attribution?.reason ?? "", /provider\/agent error/);
    // No fallback configured → no retry, no skip note.
    d = D({ exitCode: 1 } as any, undefined, { model: "litellm/primary" });
    assert.deepEqual(d, { retry: false });
    // Healthy primary → never retry, even with a configured fallback.
    d = D({ exitCode: 0, hasAssistantText: true } as any, { model: "litellm/fb" }, { model: "litellm/primary" });
    assert.deepEqual(d, { retry: false });
    // Interrupted → never retry.
    d = D({ exitCode: 1, interrupted: true } as any, { model: "litellm/fb" }, { model: "litellm/primary" });
    assert.deepEqual(d, { retry: false });
    // failedSessionFile is captured from the primary result.
    d = D({ exitCode: 1, sessionFile: "/s/failed.jsonl" } as any, { model: "litellm/fb" }, { model: "litellm/primary" });
    assert.equal(d.attribution?.failedSessionFile, "/s/failed.jsonl");
  });

  // ── hasAssistantText derivation ──

  it("sessionHasAssistantText: only non-whitespace assistant text blocks count", () => {
    const H = testApi.sessionHasAssistantText;
    assert.equal(H([]), false);
    assert.equal(
      H([{ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]),
      false,
      "user text does not count",
    );
    assert.equal(
      H([{ type: "message", id: "1", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }]),
      false,
      "toolCall-only assistant message does not count",
    );
    assert.equal(
      H([{ type: "message", id: "1", message: { role: "assistant", content: [{ type: "text", text: "   \n  " }] } }]),
      false,
      "whitespace-only text does not count",
    );
    assert.equal(
      H([
        { type: "message", id: "1", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
        { type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: " done " }] } },
      ]),
      true,
      "any assistant text block counts",
    );
  });

  // ── registry ordering (plan Risk #6) ──

  it("deleteName frees the name so the retry can reclaim it (registry ordering)", () => {
    const dir = createTestDir();
    try {
      const oldEntry = { sessionFile: "/s/failed.jsonl", sessionId: "failed-id" };
      registerName(dir, "fb", oldEntry);
      // The failed first run's entry is gone from runningSubagents (watcher)
      // and now from the registry (deleteName) → the name is free.
      deleteName(dir, "fb");
      assert.equal(readNameRegistry(dir)["fb"], undefined);
      assert.equal(nameCollisionForSpawnSafe(dir, "fb"), false, "no collision after deleteName");
      // The retry claims the name; later resumes address the RETRY session.
      registerName(dir, "fb", { sessionFile: "/s/retry.jsonl", sessionId: "retry-id" });
      assert.equal(resolveNameInRegistry(dir, "fb")?.sessionFile, "/s/retry.jsonl");
      // deleteName of an absent name is a no-op (the claimed name survives).
      deleteName(dir, "never-there");
      assert.equal(resolveNameInRegistry(dir, "fb")?.sessionFile, "/s/retry.jsonl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function nameCollisionForSpawnSafe(dir: string, name: string): boolean {
    const c = (subagentsModule as any).__test__.nameCollisionForSpawn(name, readNameRegistry(dir));
    return !!(c.running || c.reserved || c.registryEntry);
  }

  // ── end-to-end in-process: failed primary → fallback retry reclaims the name ──

  it("fallback retry re-registers the name IN PLACE (overwrite, no delete window), freezes the loadout, keeps first-run artifacts", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const gated = s3GatedBackend(sent, created);
    __setBackendForTest__(gated.backend);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    const parentArtifactDir = join(sessionDir, "artifacts", "sess-s3");

    let teardown!: (() => void) | null;
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "fb-order",
          "name: fb-order\nmodel: litellm/does-not-exist-xyz\nmodel-fallback: litellm/coding",
        );

        const spawned = await s3Spawn("fb-order", "fb-order", ctx, sent);
        teardown = spawned.teardown;
        assert.equal(spawned.result.details?.status, "started", spawned.result.content[0].text);
        const sentMessages = spawned.sentMessages;

        const primary = Array.from(testApi.runningSubagents.values()).find((r: any) => r.name === "fb-order") as any;
        assert.ok(primary, "the primary run must be in runningSubagents");

        // Simulate the primary child having written its session before dying
        // (the watcher keeps it — fallback must not touch it).
        writeFileSync(
          primary.sessionFile,
          JSON.stringify({ type: "session", id: "fb-primary", version: 3 }) + "\n",
        );

        // Overwrite-in-place precondition: BEFORE the retry launches, the
        // name already resolves to the failed primary's session file — and it
        // stays that way until the retry's registerName overwrites it in
        // place (the old deleteName window is gone).
        const preRegistry = readNameRegistry(parentArtifactDir);
        assert.equal(
          preRegistry["fb-order"]?.sessionFile,
          primary.sessionFile,
          "the entry points at the primary before the retry",
        );

        // Release the primary: it exits 1 with NO assistant text → the
        // one-shot fallback must fire (errorMessage absent, exitCode 1).
        gated.setExit(1, 1);
        gated.release(1);

        // ── In-flight ordering (Risk #6) — observed while the retry is running ──
        // Wait until the retry has registered in runningSubagents (primary
        // failed, retry launched + re-registered the name IN PLACE — its
        // registerName overwrote the failed primary's entry; no deleteName).
        // The retry registers AFTER its surface is created (shell-ready delay),
        // so wait on the map, not on the surface count.
        // The registry entry is read on EVERY iteration, so it is observed
        // while the retry's launch is still in flight (between the primary's
        // watcher finishing and the retry's registerName) — the window-safety
        // property: it must keep pointing at the FAILED PRIMARY's session
        // file, never disappear (a deleteName-before-launch regression would
        // let some read see an absent entry) and never point at the retry.
        let retryRunning: any;
        let midRegistrySeen: any[] = [];
        const retryLaunchWaitStart = Date.now();
        for (;;) {
          midRegistrySeen.push(readNameRegistry(parentArtifactDir));
          retryRunning = Array.from(testApi.runningSubagents.values()).find((r: any) => r.name === "fb-order") as any;
          if (retryRunning && retryRunning.id !== primary.id) break;
          if (Date.now() - retryLaunchWaitStart > 30_000) throw new Error("fallback retry never launched");
          await new Promise((r) => setTimeout(r, 50));
        }
        // Every registry read from before the retry's registerName onward
        // shows the name present: primary's file while the retry is in
        // flight, the retry's file once it has registered.
        assert.ok(midRegistrySeen.length > 0, "observed the registry across the launch window");
        for (const reg of midRegistrySeen) {
          const entry = reg?.["fb-order"];
          // From the primary's registerName on (which completes before
          // s3Spawn returns — i.e. by the first read here) the entry is
          // ALWAYS present: no delete window. It only ever points at the
          // primary's file until the retry's in-place overwrite.
          assert.ok(entry, "the name is registered at EVERY read of the launch window (no delete window)");
          const f = entry.sessionFile;
          assert.ok(
            f === primary.sessionFile || f === retryRunning.sessionFile,
            `the entry only ever points at the primary or the retry's file, got ${f}`,
          );
        }
        assert.equal(
          midRegistrySeen[0]["fb-order"]?.sessionFile,
          primary.sessionFile,
          "before the retry's registerName the entry points at the failed primary",
        );
        assert.notEqual(retryRunning.id, primary.id, "the retry is a NEW run");
        assert.ok(!testApi.runningSubagents.has(primary.id), "the failed first run is gone from runningSubagents");
        // Only ONE entry carries the name while the retry is in flight.
        assert.equal(
          Array.from(testApi.runningSubagents.values()).filter((r: any) => r.name === "fb-order").length,
          1,
          "no double entry for one name",
        );
        // Registry already points at the retry's session file — its
        // registerName overwrote the failed primary's entry in place — never
        // the failed primary's.
        const midRegistry = readNameRegistry(parentArtifactDir);
        assert.equal(midRegistry["fb-order"]?.sessionFile, retryRunning.sessionFile);
        assert.notEqual(midRegistry["fb-order"]?.sessionFile, primary.sessionFile);

        // Now release the retry: its exit makes the completion path run.
        gated.setExit(2, 0);
        gated.release(2);

        // ── Completion: exactly one steer, attributed, exit 0 ──
        const steer = await waitForSubagentResult(sentMessages, "fb-order", (d) => d.modelFallback);
        const steers = sentMessages.filter((m) => m.customType === "subagent_result" && m.details?.name === "fb-order");
        assert.equal(steers.length, 1, "exactly one subagent_result for the name");
        const details = steer.details;
        assert.equal(details.exitCode, 0);
        assert.equal(details.modelFallback.from, "litellm/does-not-exist-xyz");
        assert.equal(details.modelFallback.to, "litellm/coding");
        // thinking precedence: primary has none → the spawner's live level (medium).
        assert.equal(details.modelFallback.thinking, "medium");
        assert.equal(details.modelFallback.failedSessionFile, primary.sessionFile);
        assert.notEqual(details.sessionFile, primary.sessionFile);
        assert.match(steer.content, /model fallback: `litellm\/does-not-exist-xyz` → `litellm\/coding`/);
        assert.match(steer.content, /completed/);

        // Both launches went out with the right --model (primary frozen bogus,
        // retry frozen fallback + inherited thinking).
        const primaryCmd = sent.find((s) => s.surface === created[0])!.command;
        const retryCmd = sent.find((s) => s.surface === created[1])!.command;
        assert.match(primaryCmd, /--model 'litellm\/does-not-exist-xyz'/);
        assert.match(retryCmd, /--model 'litellm\/coding:medium'/);

        // The retry's loadout FROZE the fallback selection (resume replays it).
        const retryLoadout = readSubagentLoadout(retryRunning.sessionFile);
        assert.equal(retryLoadout!.model, "litellm/coding");
        assert.equal(retryLoadout!.thinking, "medium");

        // The first run's artifacts stay on disk untouched.
        assert.ok(existsSync(primary.sessionFile), "the failed primary's session file remains");
        const primaryLoadout = readSubagentLoadout(primary.sessionFile);
        assert.equal(primaryLoadout!.model, "litellm/does-not-exist-xyz", "primary loadout untouched");

        // Final registry points at the retry session; the failed run is addressable
        // only via its retained file.
        const finalRegistry = readNameRegistry(parentArtifactDir);
        assert.equal(finalRegistry["fb-order"]?.sessionFile, retryRunning.sessionFile);

        // Both runs are gone from runningSubagents at the end.
        assert.equal(
          Array.from(testApi.runningSubagents.values()).filter((r: any) => r.name === "fb-order").length,
          0,
        );
      });
    } finally {
      teardown?.();
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the fallback when it resolves to the same model+thinking as the primary (one launch, skip note, no attribution)", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const gated = s3GatedBackend(sent, created);
    __setBackendForTest__(gated.backend);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");

    let teardown!: (() => void) | null;
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        // Agent model == fallback model, and the agent declares thinking:low,
        // so the fallback's thinking (the primary's) is also low → identical pair.
        writeAgentFile(
          globalAgentsDir,
          "fb-same",
          "name: fb-same\nmodel: litellm/coding\nmodel-fallback: litellm/coding\nthinking: low",
        );

        const spawned = await s3Spawn("fb-same", "fb-same", ctx, sent);
        teardown = spawned.teardown;
        assert.equal(spawned.result.details?.status, "started", spawned.result.content[0].text);
        const sentMessages = spawned.sentMessages;

        // The failed primary is reported as-is: ONE launch, no modelFallback
        // attribution, but a skip note (the primary failed, so it is noted).
        // Wait until the launch is in, then release the (failed) exit.
        while (created.length < 1) {
          await new Promise((r) => setTimeout(r, 50));
        }
        gated.setExit(1, 1);
        gated.release(1);
        const steer = await waitForSubagentResult(sentMessages, "fb-same");
        const details = steer.details;
        assert.equal(details.exitCode, 1);
        assert.equal(details.modelFallback, undefined, "no attribution when the fallback is skipped");
        assert.match(steer.content, /model fallback skipped/);
        assert.match(steer.content, /exit code 1/);
        assert.equal(created.length, 1, "exactly one launch — no retry surface");
        assert.equal(sent.length, 1);
      });
    } finally {
      teardown?.();
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interrupting the RETRY reports the interruption notice, not a provider failure", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const gated = s3GatedBackend(sent, created);
    // Track closed surfaces: the interrupt's close must make the pane READ as
    // gone ("can't find pane"), so the retry's pollForExit declares paneGone
    // and its watcher classifies the exit as interrupted. (The real backends
    // behave this way; the plain mock's readScreenAsync would otherwise keep
    // returning an empty screen forever.) The signal itself is a no-op (the
    // real tmux `interrupt` would shell out to the tmux binary); it succeeds
    // on a live pane, and the subsequent close is what makes it gone.
    const closed = new Set<string>();
    __setBackendForTest__({
      ...gated.backend,
      interrupt: async () => {},
      closeSurface: (surface: string) => {
        closed.add(surface);
      },
      readScreenAsync: async (surface: string) => {
        if (closed.has(surface)) throw new Error("can't find pane");
        return gated.backend.readScreenAsync(surface);
      },
    } as any);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");

    let teardown!: (() => void) | null;
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "fb-retry-int",
          "name: fb-retry-int\nmodel: litellm/does-not-exist-xyz\nmodel-fallback: litellm/coding",
        );

        const spawned = await s3Spawn("fb-retry-int", "fb-retry-int", ctx, sent);
        teardown = spawned.teardown;
        assert.equal(spawned.result.details?.status, "started", spawned.result.content[0].text);
        const sentMessages = spawned.sentMessages;

        const primary = Array.from(testApi.runningSubagents.values()).find(
          (r: any) => r.name === "fb-retry-int",
        ) as any;
        assert.ok(primary, "the primary run must be in runningSubagents");
        // Simulate the primary child writing its session before dying.
        writeFileSync(
          primary.sessionFile,
          JSON.stringify({ type: "session", id: "fb-retry-int-primary", version: 3 }) + "\n",
        );

        // Fail the primary (exit 1, no text) → the one-shot fallback fires.
        gated.setExit(1, 1);
        gated.release(1);

        // Wait until the RETRY is the in-flight run under the same name (a NEW
        // id). Its watcher is now polling; the retry's exit stays gated.
        const waitFor = async (pred: (r: any) => boolean, label: string) => {
          const start = Date.now();
          for (;;) {
            const found = Array.from(testApi.runningSubagents.values()).find(pred) as any;
            if (found) return found;
            if (Date.now() - start > 30_000) throw new Error("timeout: " + label);
            await new Promise((r) => setTimeout(r, 50));
          }
        };
        const retry = await waitFor((r: any) => r.name === "fb-retry-int" && r.id !== primary.id, "retry run");
        assert.notEqual(retry.id, primary.id, "the retry is a NEW run");

        // Interrupt the retry by name, mid-run, while it is running.
        const irr = await testApi.handleSubagentInterrupt({ name: "fb-retry-int" });
        assert.equal(
          irr.details?.status,
          "interrupt_requested",
          `the interrupt must succeed, got ${JSON.stringify(irr.details)}`,
        );
        assert.equal(retry.userInterrupted, true, "the retry handle is marked interrupted");

        // The retry's watcher (paneGone + userInterrupted) reports
        // interrupted:true → finalizeInterruptedRun delivers the notice and
        // RETURNS before the normal completion code, so the result flows to
        // finalize, not to the failed-provider presentation.
        const steer = await waitForSubagentResult(sentMessages, "fb-retry-int");
        const steers = sentMessages.filter(
          (m) => m.customType === "subagent_result" && m.details?.name === "fb-retry-int",
        );
        assert.equal(steers.length, 1, "exactly one subagent_result (the interruption notice)");
        assert.equal(steer.details.interrupted, true, "result.interrupted flowed to finalize");
        assert.equal(steer.details.modelFallback, undefined, "no fallback attribution on the notice");
        assert.match(steer.content, /was interrupted by/);
        assert.doesNotMatch(steer.content, /provider\/agent error/);
        assert.doesNotMatch(steer.content, /failed/);

        // The return happened BEFORE normal completion: no second steer (a
        // provider-failure / failed exit) arrives.
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(
          sentMessages.filter(
            (m) => m.customType === "subagent_result" && m.details?.name === "fb-retry-int",
          ).length,
          1,
          "no second (failed-completion) steer after the notice",
        );
        assert.equal(
          Array.from(testApi.runningSubagents.values()).filter((r: any) => r.name === "fb-retry-int").length,
          0,
          "the retry run is gone from runningSubagents",
        );
      });
    } finally {
      teardown?.();
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── leak seam: a LATE throw in launchSubagent closes the created surface ──

  it("launchSubagent seam: a late throw in the tail closes the created surface (no leak)", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const closed = new Set<string>();
    let throwOnSend = false;
    const backend = {
      kind: "tmux",
      available: () => true,
      createSurface: async () => `seam-pane-${Math.random().toString(16).slice(2)}`,
      createSurfaceTab: async () => `seam-tab-${Math.random().toString(16).slice(2)}`,
      sendLongCommand: (surface: string, command: string) => {
        sent.push({ surface, command });
        if (throwOnSend) throw new Error("pane died in the shell-ready window");
        return `${surface}.sh`;
      },
      sendCommand: (surface: string, command: string) => sent.push({ surface, command }),
      readScreen: () => "",
      readScreenAsync: async () => "",
      closeSurface: (surface: string) => {
        closed.add(surface);
      },
      labelSurface: () => {},
      sendMessage: () => {},
    } as any;
    __setBackendForTest__(backend);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    const ctx = s3Ctx(root);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    const originalDelay = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";

    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "seam-agent", "name: seam-agent\nmodel: litellm/coding");

        // Successful launch: the surface is created, the command goes out, and
        // NOTHING is closed (the watcher owns the surface lifetime).
        throwOnSend = false;
        const ok = await testApi.launchSubagent({ agent: "seam-agent", name: "seam-ok", task: "t" }, ctx);
        assert.equal(closed.size, 0, "a successful launch leaves its surface open");
        testApi.runningSubagents.delete(ok.id);

        // Late throw (sendLongCommand after the surface exists): the surface
        // the `out` seam observed MUST be closed, no run registered, and the
        // error propagates to the caller.
        const out: { surfaceId?: string } = { surfaceId: undefined };
        throwOnSend = true;
        let threw = false;
        try {
          await testApi.launchSubagent({ agent: "seam-agent", name: "seam-late", task: "t" }, ctx, { out });
        } catch (error: any) {
          threw = true;
          assert.match(String(error?.message ?? error), /pane died in the shell-ready window/);
        }
        assert.ok(threw, "the late throw propagates to the caller");
        assert.ok(out.surfaceId, "the out seam observed the created surface id");
        assert.ok(closed.has(out.surfaceId!), "the created surface was closed before rethrow (no leak)");
        assert.equal(testApi.runningSubagents.size, 0, "no run was registered for a failed launch");
      });
    } finally {
      if (originalDelay == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = originalDelay;
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── D3 (background): --print is emitted for bg: surfaces, never for panes ──

  it("buildPiLaunchParts emits --print for a background surface and never for a pane", () => {
    // kindOf routes by surface id: bg: → the background backend; anything
    // else → the ACTIVE backend. Force each side explicitly so the test is
    // deterministic regardless of the ambient environment (a headless box
    // resolves the active backend to background, which would otherwise make
    // the pane case vacuous).
    const fakeBg = { kind: "background" } as any;
    const fakeMux = { kind: "tmux" } as any;
    try {
      __setBackendForTest__(fakeBg);
      // bg: id → background backend → explicit --print, positioned right
      // after the --session file (before the -e extension, matching the
      // plan's `pi --session <file> --print <prompt>` order).
      const bgParts = testApi.buildPiLaunchParts("/s/worker.jsonl", "bg:abc123");
      assert.equal(bgParts[0], "pi", "first part is the pi binary");
      assert.equal(bgParts[1], "--session");
      assert.equal(bgParts[2], shellEscape("/s/worker.jsonl"));
      assert.equal(bgParts[3], "--print", "a background launch must carry an explicit --print right after --session");
      assert.ok(bgParts.includes("-e"), "the subagent-done extension (-e) must still be present");

      // A shell-metachar session path is shell-escaped (same as launch/resume).
      const esc = testApi.buildPiLaunchParts("/s/we'ird.jsonl", "bg:x");
      assert.equal(esc[2], shellEscape("/s/we'ird.jsonl"), "session path must be shell-escaped");

      __setBackendForTest__(fakeMux);
      // Pane id (opaque, non-bg) → active (multiplexer) backend → no --print:
      // pane launches run the interactive TUI.
      const paneParts = testApi.buildPiLaunchParts("/s/worker.jsonl", "w7:p5");
      assert.equal(paneParts[0], "pi");
      assert.equal(paneParts[1], "--session");
      assert.equal(paneParts[2], shellEscape("/s/worker.jsonl"));
      assert.ok(!paneParts.includes("--print"), "a pane launch must NOT carry --print (interactive TUI)");
      assert.ok(paneParts.includes("-e"), "the -e extension must still be present");
    } finally {
      __setBackendForTest__(null);
    }
  });

  // ── end-to-end in-process: primary fails + retry LAUNCH throws ──

  it("fallback retry launch failure: surface closed, name stays at the failed primary (resumable), one launch-failure steer", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const closed: string[] = [];
    const gated = s3GatedBackend(sent, created);
    // The SECOND launch (the fallback retry) throws from sendLongCommand —
    // the only realistic late-throw point: the surface exists but the command
    // never reaches a live pane. The first (primary) launch is unaffected.
    let sendCalls = 0;
    const backend = {
      ...gated.backend,
      sendLongCommand: (surface: string, command: string) => {
        sendCalls += 1;
        if (sendCalls === 2) throw new Error("pane died in the shell-ready window");
        return gated.backend.sendLongCommand(surface, command);
      },
      closeSurface: (surface: string) => {
        closed.push(surface);
      },
    } as any;
    __setBackendForTest__(backend);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    const parentArtifactDir = join(sessionDir, "artifacts", "sess-s3");

    let teardown!: (() => void) | null;
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "fb-launchfail",
          "name: fb-launchfail\nmodel: litellm/does-not-exist-xyz\nmodel-fallback: litellm/coding",
        );

        const spawned = await s3Spawn("fb-launchfail", "fb-launchfail", ctx, sent);
        teardown = spawned.teardown;
        assert.equal(spawned.result.details?.status, "started", spawned.result.content[0].text);
        const sentMessages = spawned.sentMessages;

        const primary = Array.from(testApi.runningSubagents.values()).find(
          (r: any) => r.name === "fb-launchfail",
        ) as any;
        assert.ok(primary, "the primary run must be in runningSubagents");
        // The primary's surface is created BEFORE its launch command goes out,
        // so the registry already maps the name to it.
        assert.equal(
          testApi.readNameRegistry(parentArtifactDir)["fb-launchfail"]?.sessionFile,
          primary.sessionFile,
        );
        // Simulate the primary child having written its session before dying.
        writeFileSync(
          primary.sessionFile,
          JSON.stringify({ type: "session", id: "fb-launchfail-primary", version: 3 }) + "\n",
        );

        // Fail the primary (exit 1, no text) → the one-shot fallback fires and
        // its retry launch THROWS (second sendLongCommand).
        gated.setExit(1, 1);
        gated.release(1);

        const steer = await waitForSubagentResult(sentMessages, "fb-launchfail", (d) => d.launchFailed);
        const steers = sentMessages.filter(
          (m) => m.customType === "subagent_result" && m.details?.name === "fb-launchfail",
        );
        assert.equal(steers.length, 1, "exactly ONE subagent_result (the launch-failure steer)");
        assert.equal(steer.details.launchFailed, true, "the result is flagged as a launch failure");
        // Fallback attribution is KEPT: from → to + the failed primary's file.
        assert.equal(steer.details.modelFallback?.from, "litellm/does-not-exist-xyz");
        assert.equal(steer.details.modelFallback?.to, "litellm/coding");
        assert.equal(steer.details.modelFallback?.failedSessionFile, primary.sessionFile);
        assert.equal(steer.details.sessionFile, primary.sessionFile, "the failed primary's session file is reported");

        // The steer text is launch-failure-specific: names the models and the
        // launch failure, and is NOT the "auto-retry exhausted" framing
        // (nothing was ever retried).
        assert.match(steer.content, /model fallback: `litellm\/does-not-exist-xyz` → `litellm\/coding` launch failed/);
        assert.match(steer.content, /pane died in the shell-ready window/);
        assert.match(steer.content, /the failed primary run stays in artifacts/);
        assert.doesNotMatch(steer.content, /auto-retry exhausted/);
        assert.doesNotMatch(steer.content, /Fallback launch failed/);

        // NO orphaned surface: the retry's surface (created[1]) was closed by
        // launchSubagent's late-throw cleanup (without the seam it would
        // never be closed: the primary watcher only closes the PRIMARY's own
        // surface, and no watcher was ever started for the retry). Only the
        // primary's command was actually sent — the retry's child never
        // started.
        assert.equal(created.length, 2, "two surfaces were created (primary + retry)");
        assert.ok(closed.includes(created[1]), "the retry surface was closed (no orphaned pane)");
        assert.equal(sent.length, 1, "only the primary's launch command reached a surface");
        assert.equal(sent[0].surface, created[0]);

        // The registry STILL contains the name pointing at the FAILED PRIMARY's
        // session file — the launch failure never touched it, so the run stays
        // resumable by name.
        const finalRegistry = testApi.readNameRegistry(parentArtifactDir);
        assert.equal(finalRegistry["fb-launchfail"]?.sessionFile, primary.sessionFile);
        assert.ok(existsSync(primary.sessionFile), "the failed primary's session file remains on disk");
        // No run is in flight at the end.
        assert.equal(
          Array.from(testApi.runningSubagents.values()).filter((r: any) => r.name === "fb-launchfail").length,
          0,
        );
      });
    } finally {
      teardown?.();
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── window safety: between the primary's watcher finishing and the retry's
  // registerName, the registry entry keeps pointing at the failed primary ──

  it("fallback registry window: the name stays registered at the failed primary until the retry's in-place overwrite", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    const created: string[] = [];
    const gated = s3GatedBackend(sent, created);
    __setBackendForTest__(gated.backend);
    const ctx = s3Ctx(root);
    testApi.__setAlwaysOnExtensionsConfigForTest([]);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ctx.sessionManager.getSessionFile(), JSON.stringify(SESSION_HEADER) + "\n");
    const parentArtifactDir = join(sessionDir, "artifacts", "sess-s3");
    // The retry's launch is suspended INSIDE launchSubagent: the awaited
    // shell-ready delay (configurable via PI_SUBAGENT_SHELL_READY_DELAY_MS,
    // read at call time) holds it AFTER its surface was created but BEFORE
    // runningSubagents.set and the caller's registerName. The primary spawns
    // with the delay at 0; the retry (triggered later) reads the raised value
    // — so exactly the retry's launch is held in the window.
    const originalDelay = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";

    let teardown!: (() => void) | null;
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "fb-window",
          "name: fb-window\nmodel: litellm/does-not-exist-xyz\nmodel-fallback: litellm/coding",
        );

        const spawned = await s3Spawn("fb-window", "fb-window", ctx, sent);
        teardown = spawned.teardown;
        const sentMessages = spawned.sentMessages;

        const primary = Array.from(testApi.runningSubagents.values()).find((r: any) => r.name === "fb-window") as any;
        assert.ok(primary, "the primary run must be in runningSubagents");
        writeFileSync(
          primary.sessionFile,
          JSON.stringify({ type: "session", id: "fb-window-primary", version: 3 }) + "\n",
        );
        assert.equal(
          testApi.readNameRegistry(parentArtifactDir)["fb-window"]?.sessionFile,
          primary.sessionFile,
          "the entry points at the primary before the retry",
        );

        // Hold the retry's launch in the window, then fail the primary → the
        // fallback retry launches and suspends in the shell-ready delay.
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "5000";
        gated.setExit(1, 1);
        gated.release(1);

        // Wait until the retry's surface exists (created[2]) — the retry is
        // inside launchSubagent, not yet in runningSubagents, and its
        // registerName has NOT run: this is exactly the window.
        const start = Date.now();
        for (;;) {
          if (created.length === 2) break;
          if (Date.now() - start > 30_000) throw new Error("fallback retry surface never created");
          await new Promise((r) => setTimeout(r, 25));
        }
        // In the window, read the registry directly: the name is PRESENT and
        // points at the FAILED PRIMARY's session file — a resume landing here
        // continues the failed primary (a finished run, a DIFFERENT session
        // file than the retry writes — no concurrent-writer corruption), and
        // a same-name spawn is refused via nameCollisionForSpawn's registry
        // branch (asserted below). A deleteName-before-launch regression
        // would let some of these reads see an absent entry.
        const windowReads: Array<{ sessionFile?: string } | null> = [];
        for (let i = 0; i < 10; i++) {
          windowReads.push(testApi.readNameRegistry(parentArtifactDir)["fb-window"] ?? null);
          assert.ok(
            !Array.from(testApi.runningSubagents.values()).some(
              (r: any) => r.name === "fb-window" && r.id !== primary.id,
            ),
            "the retry is still inside launchSubagent (not in runningSubagents) while the window is read",
          );
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(windowReads.length > 0, "observed the registry inside the window");
        for (const entry of windowReads) {
          assert.ok(entry, "the name is registered at EVERY read inside the window (no delete window)");
          assert.equal(entry!.sessionFile, primary.sessionFile, "the entry points at the failed primary inside the window");
        }
        // A same-name spawn landing in the window is refused (registry branch).
        const collision = testApi.nameCollisionForSpawn("fb-window", testApi.readNameRegistry(parentArtifactDir));
        assert.ok(collision.registryEntry, "a same-name spawn in the window hits the registry-branch refusal");
        assert.equal(collision.registryEntry.sessionFile, primary.sessionFile);

        // Let the suspended launch finish (remaining shell-ready delay), then
        // wait for the retry to be in runningSubagents and for its
        // registerName to overwrite the entry IN PLACE.
        const retryStart = Date.now();
        let retry: any;
        for (;;) {
          retry = Array.from(testApi.runningSubagents.values()).find(
            (r: any) => r.name === "fb-window" && r.id !== primary.id,
          ) as any;
          if (retry) break;
          if (Date.now() - retryStart > 30_000) throw new Error("retry never entered runningSubagents");
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.notEqual(retry.sessionFile, primary.sessionFile, "the retry has its own session file");
        const overwriteStart = Date.now();
        for (;;) {
          if (testApi.readNameRegistry(parentArtifactDir)["fb-window"]?.sessionFile === retry.sessionFile) break;
          if (Date.now() - overwriteStart > 30_000) throw new Error("retry never re-registered the name");
          await new Promise((r) => setTimeout(r, 25));
        }

        // Finish cleanly: release the retry's exit and let the completion
        // path run.
        gated.setExit(2, 0);
        gated.release(2);
        await waitForSubagentResult(sentMessages, "fb-window", (d) => d.modelFallback);
        assert.equal(
          testApi.readNameRegistry(parentArtifactDir)["fb-window"]?.sessionFile,
          retry.sessionFile,
          "after the in-place overwrite the entry points at the retry",
        );
      });
    } finally {
      if (originalDelay == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = originalDelay;
      teardown?.();
      __setBackendForTest__(null);
      testApi.runningSubagents.clear();
      testApi.__setAlwaysOnExtensionsConfigForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent message renderers are click-expandable", () => {
  // keyHint() (used for the collapsed "to expand" hint) reads pi-coding-agent's
  // global theme singleton, which throws until initialized. Seed it for the
  // duration of these tests (the real TUI always has one).
  const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = (globalThis as any)[THEME_KEY];
  beforeEach(() => {
    (globalThis as any)[THEME_KEY] = {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  });
  afterEach(() => {
    if (previousTheme === undefined) {
      delete (globalThis as any)[THEME_KEY];
    } else {
      (globalThis as any)[THEME_KEY] = previousTheme;
    }
  });

  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  const CLICK = { type: "click", button: "left" };

  function resultMessage(content: string) {
    return {
      customType: "subagent_result",
      content,
      details: {
        name: "Worker",
        agent: "worker",
        exitCode: 0,
        elapsed: 42,
        sessionFile: "/tmp/subagent.jsonl",
        stats: { toolCount: 3, inputTokens: 850, outputTokens: 120, model: "claude-x", contextTokens: 37000 },
      },
    };
  }

  it("subagent_result toggles between collapsed and full on left click", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(rendererEntry, "expected subagent_result renderer to be registered");

    const component = rendererEntry.renderer(
      resultMessage(
        'Sub-agent "Worker" completed (42s).\n\n' +
          "Line one of the summary.\n" +
          "Line two of the summary.\n" +
          "Line three of the summary.\n" +
          "Line four of the summary.\n" +
          "Line five of the summary.\n" +
          "Line six of the summary.\n" +
          "Line seven of the summary.\n" +
          "\nFollow up with subagent_message({ name: \"Worker\", message: \"…\" })",
      ),
      { expanded: false, outputPad: 1 },
      createTheme(),
    );
    assert.ok(component, "expected the renderer to return a component");

    // Collapsed: a 5-line preview, the "more lines" note, and the expand hint. No session info.
    let output = component.render(80).join("\n");
    assert.match(output, /Line one of the summary/);
    assert.doesNotMatch(output, /Line six of the summary/);
    assert.match(output, /… 2 more lines/);
    assert.match(output, /to expand/);
    assert.doesNotMatch(output, /Session file:/);

    // A left click toggles it open (the TUI synthesizes a click event on release).
    assert.deepEqual(component.handleMouse(CLICK), { handled: true });
    output = component.render(80).join("\n");
    assert.match(output, /Line seven of the summary/);
    assert.match(output, /Session file: \/tmp\/subagent\.jsonl/);
    assert.doesNotMatch(output, /to expand/);

    // Another click collapses it again.
    assert.deepEqual(component.handleMouse(CLICK), { handled: true });
    output = component.render(80).join("\n");
    assert.doesNotMatch(output, /Line seven of the summary/);
    assert.match(output, /to expand/);
  });

  it("wraps long summary lines instead of truncating them", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(rendererEntry, "expected subagent_result renderer to be registered");

    // A single summary line far longer than the render width. The box's
    // content width at width=80 is 80 - 6 = 74, so the line must wrap onto
    // multiple physical lines while keeping every character (no slice).
    const longWordA = "a".repeat(74);
    const longWordB = "b".repeat(74);
    const component = rendererEntry.renderer(
      resultMessage(`Sub-agent "Worker" completed (42s).\n\n${longWordA} middle ${longWordB}`),
      { expanded: true, outputPad: 1 },
      createTheme(),
    );
    assert.ok(component, "expected the renderer to return a component");

    const output = component.render(80).join("\n");
    // No physical line may exceed the box width.
    for (const line of output.split("\n")) {
      assert.ok(line.length <= 80, `line exceeds box width: ${line.length}`);
    }
    // The wrapped continuation fragments of both long words are all present.
    for (const part of ["aaaa", "bbbb"] as const) {
      assert.match(output, new RegExp(`${part}{10,}`), `expected a wrapped fragment of the long word (${part})`);
    }
    // And the middle word that sits between them survived the wrap.
    assert.match(output, / middle /);
  });

  it("respects the initial expanded state and ignores non-left-button clicks", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(rendererEntry);

    const component = rendererEntry.renderer(
      resultMessage('Sub-agent "Worker" completed (42s).\n\nOnly summary line.'),
      { expanded: true, outputPad: 1 },
      createTheme(),
    );
    assert.ok(component);

    // Start already expanded.
    assert.match(component.render(80).join("\n"), /Session file:/);

    // Non-left-button and non-click events are ignored.
    assert.equal(component.handleMouse({ type: "click", button: "right" }), undefined);
    assert.equal(component.handleMouse({ type: "press", button: "left" }), undefined);
    assert.equal(component.handleMouse({ type: "release", button: "left" }), undefined);
    // Still expanded (unchanged).
    assert.match(component.render(80).join("\n"), /Session file:/);

    // A left click collapses.
    component.handleMouse(CLICK);
    assert.doesNotMatch(component.render(80).join("\n"), /Session file:/);
  });

  it("subagent_status and subagent_question are click-expandable too", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const statusEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    const questionEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_question");
    assert.ok(statusEntry, "expected subagent_status renderer");
    assert.ok(questionEntry, "expected subagent_question renderer");

    const status = statusEntry.renderer(
      { customType: "subagent_status", content: "", details: { lines: ["Worker running 5m."], overflow: 1 } },
      { expanded: false, outputPad: 1 },
      createTheme(),
    );
    assert.ok(status);
    assert.match(status.render(80).join("\n"), /to expand/);
    // Clicking toggles the expand hint off (overflow count stays visible).
    assert.deepEqual(status.handleMouse(CLICK), { handled: true });
    assert.doesNotMatch(status.render(80).join("\n"), /to expand/);
    assert.match(status.render(80).join("\n"), /\+1 more running\./);

    const question = questionEntry.renderer(
      { customType: "subagent_question", content: "", details: { name: "Scout", agent: "scout", question: "Which DB should I use?\nSecond question line." } },
      { expanded: false, outputPad: 1 },
      createTheme(),
    );
    assert.ok(question);
    let out = question.render(80).join("\n");
    assert.match(out, /Which DB should I use\?/);
    assert.doesNotMatch(out, /Second question line/);
    assert.deepEqual(question.handleMouse(CLICK), { handled: true });
    out = question.render(80).join("\n");
    assert.match(out, /Second question line/);
    assert.match(out, /Reply: subagent_message/);
  });

  it("persists the click choice across host rebuilds but yields to Ctrl+O", () => {
    // pi's CustomMessageComponent re-invokes the renderer (rebuilding the
    // component) on theme/output-pad changes and on the global Ctrl+O toggle.
    // A rebuild must not silently discard the user's per-message click choice.
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(rendererEntry, "expected subagent_result renderer to be registered");

    const message = resultMessage('Sub-agent "Worker" completed (42s).\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.');
    const options = { expanded: false, outputPad: 1 };

    // First render: collapsed.
    const first = rendererEntry.renderer(message, options, createTheme());
    assert.ok(first);
    assert.match(first.render(80).join("\n"), /to expand/);

    // Click to expand.
    first.handleMouse(CLICK);

    // The host rebuilds (theme change, output-pad change, ...) by calling the
    // renderer again with the SAME options.expanded. The click choice survives.
    const rebuilt = rendererEntry.renderer(message, options, createTheme());
    assert.ok(rebuilt);
    assert.doesNotMatch(rebuilt.render(80).join("\n"), /to expand/);
    assert.match(rebuilt.render(80).join("\n"), /Line seven/);

    // A global Ctrl+O toggle re-renders with options.expanded CHANGED. The
    // global toggle overrides the per-message click choice (matches built-ins).
    const afterCtrlO = rendererEntry.renderer(message, { expanded: true, outputPad: 1 }, createTheme());
    assert.ok(afterCtrlO);
    assert.doesNotMatch(afterCtrlO.render(80).join("\n"), /to expand/);

    // Ctrl+O collapse (options.expanded back to false) overrides the click-open state.
    const afterCtrlOCollapse = rendererEntry.renderer(message, options, createTheme());
    assert.ok(afterCtrlOCollapse);
    assert.match(afterCtrlOCollapse.render(80).join("\n"), /to expand/);

    // A different message is tracked independently (no shared-state bug).
    const other = resultMessage('Sub-agent "Scout" completed (5s).\n\nOther one.\nOther two.\nOther three.\nOther four.\nOther five.\nOther six.\nOther seven.');
    const otherComp = rendererEntry.renderer(other, options, createTheme());
    assert.ok(otherComp);
    assert.match(otherComp.render(80).join("\n"), /to expand/);
  });
});

describe("subagent spawn surface policy", () => {
  const testApi = (subagentsModule as any).__test__;
  const ENV = "PI_SUBAGENT_SPAWN_SURFACE";

  afterEach(() => {
    delete process.env[ENV];
  });

  it("returns the config surface when the env override is unset", () => {
    // Must not hardcode "panes": a user's (gitignored) config.json may set
    // "tabs", and getSpawnSurface() correctly returns the config value then.
    delete process.env[ENV];
    const configSurface = loadSubagentConfig().spawn.surface;
    assert.equal(testApi.getSpawnSurface(), configSurface);
  });

  it("honours the PI_SUBAGENT_SPAWN_SURFACE override (case-insensitive)", () => {
    process.env[ENV] = "tabs";
    assert.equal(testApi.getSpawnSurface(), "tabs");
    process.env[ENV] = " Panes ";
    assert.equal(testApi.getSpawnSurface(), "panes");
  });

  it("throws on an unrecognised override value", () => {
    process.env[ENV] = "windows";
    assert.throws(() => testApi.getSpawnSurface(), /Invalid PI_SUBAGENT_SPAWN_SURFACE value/);
  });

  it("decides tab vs pane from surface policy and depth (shouldOpenTab)", () => {
    const { shouldOpenTab } = testApi;
    // tabs mode, top-level session (not itself a subagent) -> a tab
    assert.equal(shouldOpenTab({ surface: "tabs", isSubagentSession: false }), true);
    // tabs mode, nested subagent (PI_SUBAGENT_SESSION set) -> a pane in its own tab
    assert.equal(shouldOpenTab({ surface: "tabs", isSubagentSession: true }), false);
    // panes mode (default) -> always a pane, at any depth
    assert.equal(shouldOpenTab({ surface: "panes", isSubagentSession: false }), false);
    assert.equal(shouldOpenTab({ surface: "panes", isSubagentSession: true }), false);
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });

  it("formatWidgetRightLabel annotates waiting rows with their reason", () => {
    const testApi = (subagentsModule as any).__test__;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    function waitingState(overrides: Record<string, unknown>) {
      const state: SubagentStatusState = {
        source: "pi",
        startTimeMs: 0,
        firstObservationAtMs: 10_000,
        lastActivityAtMs: 10_000,
        lastActivitySequence: 1,
        localOverrideAtMs: null,
        localOverrideSequence: null,
        activeNow: false,
        activeSinceMs: null,
        activeScope: null,
        waitingSinceMs: 10_000,
        waitingReason: null,
        phase: "waiting",
        latestEvent: "agent_end",
        activityLabel: null,
        snapshotState: "present",
        snapshotProblemSinceMs: null,
        snapshotError: null,
        currentKind: "waiting",
        ...overrides,
      };
      return state;
    }

    // Both reason annotations render into the detail slot (now = 130_000, parked at 10_000 → 2m wait).
    assert.equal(
      strip(testApi.formatWidgetRightLabel(classifyStatus(waitingState({ waitingReason: "own_children" }), 130_000))),
      " waiting 2m · own children ",
    );
    assert.equal(
      strip(testApi.formatWidgetRightLabel(classifyStatus(waitingState({ waitingReason: "ask_question" }), 130_000))),
      " waiting 2m · question ",
    );

    // No reason → unannotated default (unchanged from today).
    assert.equal(
      strip(testApi.formatWidgetRightLabel(classifyStatus(waitingState({ waitingReason: null }), 130_000))),
      " waiting 2m ",
    );

    // statusLabel precedence: an existing problem/state label wins the slot
    // (e.g. "done" on a finished-but-still-observed child).
    assert.equal(
      strip(testApi.formatWidgetRightLabel(classifyStatus(waitingState({
        waitingReason: "own_children",
        phase: "done",
      }), 130_000))),
      " waiting 2m · done ",
    );
    // An interrupt-style label beats an actionable reason: the interrupt
    // state carries "interrupted" as its label (activityLabel) and the label
    // slot takes precedence over the waiting reason.
    assert.equal(strip(testApi.formatWidgetRightLabel({
      kind: "waiting",
      elapsedMs: 130_000,
      elapsedText: "2m",
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: 10_000,
      waitingReason: "ask_question",
      waitingDurationText: "2m",
      latestEvent: "interrupt_requested",
      activityLabel: "interrupted",
      snapshotState: "present",
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    } satisfies StatusSnapshot)), " waiting 2m · interrupted ");
  });

  it("renderSubagentWidgetLines shows the waiting reason on a parked row", () => {
    const testApi = (subagentsModule as any).__test__;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    const now = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const statusState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: now - 120_000 }),
        {
          snapshot: "present",
          updatedAt: now - 120_000,
          sequence: 1,
          phase: "waiting",
          waitingSince: now - 120_000,
          waitingReason: "own_children",
        },
        now,
      );
      const lines = testApi.renderSubagentWidgetLines(
        [{
          id: "a1",
          name: "s2-worker",
          task: "",
          surface: "s1",
          startTime: now - 120_000,
          sessionFile: "sess1",
          statusState,
        }],
        56,
      );
      const body = lines.map(strip).join("\n");
      assert.match(body, /s2-worker/);
      assert.match(body, /waiting 2m · own children/);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("tmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});

describe("herdr.ts layout balance", () => {
  const pane = (id: string): HerdrLayoutNode => ({ type: "pane", pane_id: id });
  const split = (first: HerdrLayoutNode, second: HerdrLayoutNode, ratio = 0.5): HerdrLayoutNode => ({
    type: "split",
    direction: "right",
    ratio,
    first,
    second,
  });

  describe("balanceLeafCount", () => {
    it("counts leaf panes under a tree", () => {
      assert.equal(balanceLeafCount(null), 0);
      assert.equal(balanceLeafCount(undefined), 0);
      assert.equal(balanceLeafCount(pane("w1:p1")), 1);
      const tree = split(pane("a"), split(pane("b"), pane("c")));
      assert.equal(balanceLeafCount(tree), 3);
    });
  });

  describe("balanceTree", () => {
    it("returns no calls for a single pane or null", () => {
      assert.deepEqual(balanceTree(pane("a")), []);
      assert.deepEqual(balanceTree(null), []);
    });

    it("balances a 2-pane split at the root", () => {
      const tree = split(pane("a"), pane("b"), 0.25);
      assert.deepEqual(balanceTree(tree), [{ path: [], ratio: 0.5 }]);
    });

    it("balances an uneven 4-pane chain by pane count", () => {
      // (a | (b | (c | d))) — every split should give its subtrees equal width
      const tree = split(pane("a"), split(pane("b"), split(pane("c"), pane("d"))), 0.5);
      const calls = balanceTree(tree);
      assert.deepEqual(calls, [
        { path: [], ratio: 1 / 4 },
        { path: [true], ratio: 1 / 3 },
        { path: [true, true], ratio: 0.5 },
      ]);
    });

    it("preserves subtree proportions in a 3-pane tree with a 1+2 split", () => {
      // (a | (b | c)) → root 1/3 (a gets a third), inner 1/2
      const tree = split(pane("a"), split(pane("b"), pane("c")), 0.75);
      assert.deepEqual(balanceTree(tree), [
        { path: [], ratio: 1 / 3 },
        { path: [true], ratio: 0.5 },
      ]);
    });

    it("preserves proportions in a balanced 5-pane tree", () => {
      // ((a | b) | (c | (d | e))) → root 2/5, left 1/2, right 1/3
      const tree = split(
        split(pane("a"), pane("b")),
        split(pane("c"), split(pane("d"), pane("e"))),
      );
      assert.deepEqual(balanceTree(tree), [
        { path: [], ratio: 2 / 5 },
        { path: [false], ratio: 0.5 },
        { path: [true], ratio: 1 / 3 },
        { path: [true, true], ratio: 0.5 },
      ]);
    });

    it("emits calls root-first so deeper splits resize inside corrected areas", () => {
      const tree = split(pane("a"), split(pane("b"), pane("c")));
      const depths = balanceTree(tree).map((c) => c.path.length);
      // Depth must be non-decreasing: root before its children.
      assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
      assert.equal(depths[0], 0);
    });
  });

  describe("isLayoutEven", () => {
    const mk = (width: number, height = 50) => ({ pane_id: "x", rect: { x: 0, y: 0, width, height } });

    it("accepts a single pane", () => {
      assert.equal(isLayoutEven([mk(100)]), true);
    });

    it("accepts widths/heights differing by at most one cell", () => {
      assert.equal(isLayoutEven([mk(43), mk(42), mk(43), mk(42)]), true);
      assert.equal(isLayoutEven([mk(43), mk(43)]), true);
    });

    it("rejects visibly uneven layouts", () => {
      assert.equal(isLayoutEven([mk(43), mk(21), mk(21), mk(85)]), false);
      assert.equal(isLayoutEven([mk(40), mk(38)]), false);
    });
  });

  describe("isHerdrAvailable / herdrSocketPath", () => {
    it("requires HERDR_ENV=1, an existing socket path, and the CLI on PATH", () => {
      // The real environment may be a herdr session; test the env contract
      // explicitly instead of relying on process.env.
      const fakeSocket = join(createTestDir(), "herdr.sock");
      writeFileSync(fakeSocket, "");
      try {
        assert.equal(isHerdrAvailable({} as any), false);
        assert.equal(isHerdrAvailable({ HERDR_ENV: "1" } as any), false);
        assert.equal(isHerdrAvailable({ HERDR_ENV: "0", HERDR_SOCKET_PATH: fakeSocket } as any), false);
        // A non-existent socket path is unavailable even with HERDR_ENV=1.
        assert.equal(
          isHerdrAvailable({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nonexistent/herdr.sock" } as any),
          false,
        );
        // HERDR_ENV=1 + an existing socket + herdr CLI on PATH → available.
        // (Skipped if the herdr binary is not installed in this environment.)
        if (hasCommandLocally("herdr")) {
          assert.equal(
            isHerdrAvailable({ HERDR_ENV: "1", HERDR_SOCKET_PATH: fakeSocket } as any),
            true,
          );
        }
        assert.equal(herdrSocketPath({} as any), null);
        assert.equal(herdrSocketPath({ HERDR_SOCKET_PATH: "  " } as any), null);
        assert.equal(herdrSocketPath({ HERDR_SOCKET_PATH: fakeSocket } as any), fakeSocket);
        assert.equal(
          herdrSocketPath({ HERDR_SOCKET_PATH: "/nonexistent/herdr.sock" } as any),
          null,
        );
      } finally {
        rmSync(fakeSocket, { force: true });
      }
    });
  });
});

describe("herdr.ts backport", () => {
  const prevSplitDirection = process.env.PI_SUBAGENT_SPLIT_DIRECTION;
  after(() => restoreEnvVar("PI_SUBAGENT_SPLIT_DIRECTION", prevSplitDirection));

  describe("herdrCli stderr isolation", () => {
    // The `herdr` CLI writes its errors to STDERR as JSON. Node's execFileSync,
    // when called with no stdio option, re-forwards the CAPTURED child stderr
    // to the parent's stderr in addition to exposing it on the thrown error.
    // Inside a herdr pane the parent's stderr IS the user's TTY, so a CLI
    // failure (e.g. pane_not_found when a just-closed pane is re-closed) would
    // flash its error JSON onto the screen even though herdrCli catches and
    // re-throws it. These tests pin the isolation: herdrCli must keep the JSON
    // on the error (for isSurfaceGoneError) while keeping it OFF the parent's
    // stderr. A regression to a bare execFileSync(...) (no stdio) fails here.
    it("keeps a CLI failure on the thrown error but NOT on the parent's stderr", () => {
      const dir = createTestDir();
      const fakeHerdr = join(dir, "herdr");
      // A stand-in herdr CLI: error JSON on stderr, non-zero exit — exactly
      // the shape a real `pane read`/`close` failure has.
      const errJson = JSON.stringify({
        error: { code: "pane_not_found", message: "pane w7:pLEAK not found" },
        id: "cli:pane:read",
      });
      writeFileSync(fakeHerdr, `#!/bin/sh\nprintf '%s' '${errJson}' >&2\nexit 1\n`, { mode: 0o755 });
      chmodSync(fakeHerdr, 0o755);

      const prevBin = process.env.HERDR_BIN_PATH;
      const captured: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      // Spy on the parent process's stderr (the pane TTY) without losing it.
      process.stderr.write = (chunk: any, ...rest: any[]) => {
        if (typeof chunk === "string") captured.push(chunk);
        else if (Buffer.isBuffer(chunk)) captured.push(chunk.toString("utf8"));
        return originalWrite(chunk, ...rest);
      };
      process.env.HERDR_BIN_PATH = fakeHerdr;
      try {
        let threw: any = null;
        try {
          __herdrCliForTest__(["pane", "read", "w7:pLEAK"]);
        } catch (e) {
          threw = e;
        }
        assert.ok(threw, "herdrCli must throw on a non-zero CLI exit");
        // The error keeps the captured JSON (isSurfaceGoneError depends on it).
        assert.ok(
          /pane[_ -]?not[_ -]?found/.test(String(threw?.message ?? "")),
          `error message should carry the CLI JSON, got: ${threw?.message}`,
        );
        // …and it did NOT leak onto the parent's stderr.
        const leaked = captured.join("");
        assert.equal(
          leaked.includes("pane_not_found"),
          false,
          `CLI error JSON must not be re-forwarded to the parent stderr, got: ${leaked}`,
        );
      } finally {
        process.stderr.write = originalWrite;
        if (prevBin === undefined) delete process.env.HERDR_BIN_PATH;
        else process.env.HERDR_BIN_PATH = prevBin;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("chooseSplitDirection", () => {
    it("splits wide panes right (more than two columns per row)", () => {
      assert.equal(chooseSplitDirection({ width: 200, height: 50 }, "auto"), "right");
    });

    it("splits narrow/tall panes down", () => {
      assert.equal(chooseSplitDirection({ width: 80, height: 50 }, "auto"), "down");
    });

    it("treats an exactly 2:1 pane as wide", () => {
      assert.equal(chooseSplitDirection({ width: 100, height: 50 }, "auto"), "right");
    });

    it("falls back to right when the rect is missing", () => {
      assert.equal(chooseSplitDirection(null, "auto"), "right");
      assert.equal(chooseSplitDirection(undefined, "auto"), "right");
    });

    it("falls back to right for a zero-height rect", () => {
      assert.equal(chooseSplitDirection({ width: 100, height: 0 }, "auto"), "right");
    });

    it("lets an explicit setting win over the geometry", () => {
      assert.equal(chooseSplitDirection({ width: 200, height: 50 }, "down"), "down");
      assert.equal(chooseSplitDirection({ width: 80, height: 50 }, "right"), "right");
    });
  });

  describe("splitDirectionSetting", () => {
    it("defaults to auto", () => {
      delete process.env.PI_SUBAGENT_SPLIT_DIRECTION;
      assert.equal(splitDirectionSetting(), "auto");
    });

    it("normalizes case and trims whitespace", () => {
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "RIGHT";
      assert.equal(splitDirectionSetting(), "right");
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = " down ";
      assert.equal(splitDirectionSetting(), "down");
    });

    it("treats garbage values as auto", () => {
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "diagonal";
      assert.equal(splitDirectionSetting(), "auto");
    });
  });

  describe("isAgentNotFound", () => {
    it("matches agent_not_found errors from the agent surface", () => {
      assert.equal(
        isAgentNotFound(
          new Error(
            'herdr agent prompt failed: {"error":{"code":"agent_not_found","message":"no agent in pane"}}',
          ),
        ),
        true,
      );
    });

    it("does not match agent_blocked (approval/question dialogs)", () => {
      assert.equal(
        isAgentNotFound(new Error('herdr agent prompt failed: {"error":{"code":"agent_blocked"}}')),
        false,
      );
    });

    it("does not match other herdr failures", () => {
      assert.equal(isAgentNotFound(new Error("herdr pane close failed: no such pane")), false);
    });

    it("does not match non-Error values", () => {
      assert.equal(isAgentNotFound(null), false);
      assert.equal(isAgentNotFound(undefined), false);
    });
  });

  describe("getHerdrStateExtensionPath", () => {
    it("returns the extension path when the file exists under PI_CODING_AGENT_DIR", () => {
      const dir = createTestDir();
      const prevDir = process.env.PI_CODING_AGENT_DIR;
      try {
        const extDir = join(dir, "extensions");
        mkdirSync(extDir, { recursive: true });
        writeFileSync(join(extDir, "herdr-agent-state.ts"), "// stub\n");
        process.env.PI_CODING_AGENT_DIR = dir;
        const path = (subagentsModule as any).__test__.getHerdrStateExtensionPath();
        assert.ok(
          typeof path === "string" && path.endsWith("extensions/herdr-agent-state.ts"),
          `expected a path ending in extensions/herdr-agent-state.ts, got: ${path}`,
        );
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", prevDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null when the file is absent", () => {
      const dir = createTestDir();
      const prevDir = process.env.PI_CODING_AGENT_DIR;
      try {
        process.env.PI_CODING_AGENT_DIR = dir;
        assert.equal((subagentsModule as any).__test__.getHerdrStateExtensionPath(), null);
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", prevDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  describe("flattenForRawPane", () => {
    it("collapses newlines to single spaces and trims", () => {
      assert.equal(flattenForRawPane("do this\nthen that"), "do this then that");
      assert.equal(flattenForRawPane("a\n\n\tb\n\nc"), "a b c");
      assert.equal(flattenForRawPane("  spaced  "), "spaced");
      assert.equal(flattenForRawPane("single line"), "single line");
    });
  });
});

describe("surface.ts backend selection", () => {
  after(() => {
    __setBackendForTest__(null);
  });

  it("detects a backend from the environment (herdr before tmux)", () => {
    const kind = detectMux()?.kind ?? null;
    // herdr requires HERDR_ENV=1 + socket + CLI; tmux requires TMUX + CLI.
    // Whichever environment the tests run in, the detected kind must agree.
    if (kind === "herdr") {
      assert.equal(process.env.HERDR_ENV, "1");
    } else if (kind === "tmux") {
      assert.ok(process.env.TMUX);
      // herdr must NOT be available when tmux was chosen
      assert.equal(isHerdrAvailable(), false);
    } else {
      assert.ok(!process.env.TMUX || !process.env.HERDR_ENV);
    }
  });

  it("muxKind/isMuxAvailable follow the detected backend", () => {
    const kind = muxKind();
    assert.equal(isMuxAvailable(), kind !== null);
  });

  it("a forced backend wins over environment detection", () => {
    __setBackendForTest__({ kind: "herdr" } as any);
    assert.equal(detectMux()?.kind, "herdr");
    assert.equal(muxKind(), "herdr");
    assert.equal(isMuxAvailable(), true);
    __setBackendForTest__(null);
  });

  it("pollForExit sidecar semantics are shared with the tmux module", () => {
    assert.equal(surfacePollForExitTest.interpretExitSidecar, __pollForExitTest__.interpretExitSidecar);
  });

  // ── Dead-pane detection (interrupt teardown) ──

  function readFailsWith(message: string) {
    return {
      kind: "herdr",
      available: () => true,
      readScreenAsync: async () => {
        throw new Error(message);
      },
    } as any;
  }

  function abortable(timeoutMs: number) {
    const c = new AbortController();
    setTimeout(() => c.abort(), timeoutMs);
    return c.signal;
  }

  it("returns paneGone after two consecutive GONE-pane read failures (herdr string)", async () => {
    __setBackendForTest__(readFailsWith('herdr pane read … failed: {"error":{"code":"pane_not_found","message":"pane w7:pX not found"}}'));
    const result = await pollForExit("w7:pX", abortable(5000), { interval: 20 });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.equal(result.paneGone, true);
  });

  it("returns paneGone after two consecutive GONE-pane read failures (tmux string)", async () => {
    __setBackendForTest__(readFailsWith("can't find pane"));
    const result = await pollForExit("%99", abortable(5000), { interval: 20 });
    assert.equal(result.reason, "error");
    assert.equal(result.paneGone, true);
  });

  it("transient (non-gone) read errors keep polling — they never return paneGone", async () => {
    __setBackendForTest__(readFailsWith("herdr socket timeout after 5000ms calling pane.read"));
    let result: any;
    await assert.rejects(
      pollForExit("w7:pX", abortable(300), { interval: 20 }).then((r) => {
        result = r;
      }),
      /Aborted/,
    );
    assert.equal(result?.paneGone, undefined, "a live pane with transient read errors must not be reported gone");
  });

  it("isSurfaceGoneError matches pane-gone errors only, not workspace/socket/server errors", () => {
    assert.equal(isSurfaceGoneError(new Error('herdr pane read … failed: {"error":{"code":"pane_not_found","message":"pane w7:pX not found"}}')), true);
    assert.equal(isSurfaceGoneError(new Error("can't find pane")), true);
    assert.equal(isSurfaceGoneError(new Error('herdr pane get … failed: {"error":{"code":"workspace_not_found","message":"workspace not found"}}')), false, "workspace not found is not a gone pane");
    assert.equal(isSurfaceGoneError(new Error("herdr socket timeout after 5000ms calling pane.read")), false, "socket timeouts are transient");
    assert.equal(isSurfaceGoneError(new Error("server not found")), false, "bare 'not found' must not match");
  });

  // ── Backend resolution matrix (pure resolver) ──

  const NO_ENV: NodeJS.ProcessEnv = {};
  const avail = (herdr: boolean, tmux: boolean) => ({ herdr, tmux });

  it("resolveSurfaceBackend: auto is herdr → tmux → background floor (never null)", () => {
    assert.equal(resolveSurfaceBackend("auto", NO_ENV, avail(true, true)).kind, "herdr");
    assert.equal(resolveSurfaceBackend("auto", NO_ENV, avail(true, false)).kind, "herdr");
    assert.equal(resolveSurfaceBackend("auto", NO_ENV, avail(false, true)).kind, "tmux");
    assert.equal(resolveSurfaceBackend("auto", NO_ENV, avail(false, false)).kind, "background");
  });

  it("resolveSurfaceBackend: explicit beats environment, unavailable explicit throws", () => {
    assert.equal(resolveSurfaceBackend("background", NO_ENV, avail(true, true)).kind, "background");
    assert.equal(resolveSurfaceBackend("tmux", NO_ENV, avail(true, true)).kind, "tmux");
    assert.throws(
      () => resolveSurfaceBackend("herdr", NO_ENV, avail(false, true)),
      /herdr subagent backend was requested but is not available/i,
    );
    assert.throws(
      () => resolveSurfaceBackend("tmux", NO_ENV, avail(true, false)),
      /tmux subagent backend was requested but is not available/i,
    );
    // Explicit-but-available never throws, even when the env says otherwise.
    assert.equal(resolveSurfaceBackend("herdr", NO_ENV, avail(true, false)).kind, "herdr");
  });

  it("resolveSpawnBackend: env override beats config, invalid override throws", () => {
    assert.equal(resolveSpawnBackend("background", "herdr"), "background");
    assert.equal(resolveSpawnBackend("  TMUX ", "auto"), "tmux");
    assert.equal(resolveSpawnBackend(undefined, "tmux"), "tmux");
    assert.equal(resolveSpawnBackend("", "background"), "background");
    assert.throws(
      () => resolveSpawnBackend("warp", "auto"),
      /Invalid PI_SUBAGENT_BACKEND=\"warp\"; expected/,
    );
  });

  it("activeBackend: env override beats config preference beats detection", () => {
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      // Config alone (no env): an explicit config preference beats detection.
      setConfigBackendPreference("background");
      assert.equal(activeBackend().kind, "background");

      // Env override beats even a conflicting explicit config preference.
      process.env.PI_SUBAGENT_BACKEND = "background";
      setConfigBackendPreference("herdr"); // would throw on detection if consulted
      assert.equal(activeBackend().kind, "background");

      // An invalid env override is a configuration error (thrown at resolution).
      process.env.PI_SUBAGENT_BACKEND = "warp";
      setConfigBackendPreference("auto");
      assert.throws(() => activeBackend(), /Invalid PI_SUBAGENT_BACKEND=\"warp\"/);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      setConfigBackendPreference("auto");
    }
  });

  // ── bg: surface behaviour (facade + background backend) ──

  it("bg: create yields a bg: id; tabs/splits and steering refuse; label/send are no-ops", async () => {
    __setBackendForTest__(backgroundBackend);
    try {
      const surface = await createSurface("worker");
      assert.match(surface, /^bg:\d+-[0-9a-f]{6}$/);
      assert.equal(kindOf(surface), "background");
      assert.equal(kindOf("%12"), "background", "forced backend applies to non-bg ids too");
      assert.ok(hasBackgroundSurface(surface));
      assert.equal(backgroundLogPathOf(surface), undefined, "no log path until launch");

      sendCommand(surface, "echo hi"); // no-op, must not throw
      labelSurface(surface, "worker"); // no-op, must not throw
      assert.equal(readScreen(surface, 50), "", "empty before launch");

      await assert.rejects(createSurfaceTab("worker"), /no tabs or splits/);
      await assert.rejects(createSurfaceSplit("worker", "right"), /no tabs or splits/);
      assert.throws(() => sendMessage(surface, "steer me"), /cannot be steered \(no TUI\)/);
    } finally {
      __setBackendForTest__(null);
    }
  });

  it("bg: readScreen is the log tail and sendLongCommand derives the log path", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      setConfigBackendPreference("background");
      __resetActiveBackendCacheForTest__();

      const logPath = join(dir, "logs", "worker-abc123.log");
      const surface = createBackgroundSurface("abc123", logPath);
      for (let i = 1; i <= 20; i++) writeFileSync(logPath, `line${i}\n`, { flag: "a" });

      const tail = readScreen(surface, 5);
      assert.ok(tail.includes("line16"), `tail should include line16: ${tail}`);
      assert.ok(tail.endsWith("line20\n"));
      assert.ok(!tail.includes("line15"), "tail must not reach further than 5 lines back");
      // Non-bg ids route to the active backend (background here, no record → "").
      assert.equal(readScreen("%99", 50), "");
      assert.equal(backgroundLogPathOf("%99"), undefined);

      // sendLongCommand derives the log path from the caller's script path:
      // artifacts/<sessionId>/subagent-scripts/<name>-<id>.sh →
      // artifacts/<sessionId>/subagent-logs/<name>-<id>.log
      const artifactDir = join(dir, "artifacts", "sess-1");
      const scriptPath = join(artifactDir, "subagent-scripts", "worker-abc123.sh");
      const bgSurface = createBackgroundSurface("abc123b", undefined);
      const returned = backgroundBackend.sendLongCommand(bgSurface, "echo hi", { scriptPath });
      assert.equal(returned, scriptPath);
      assert.ok(existsSync(scriptPath));
      assert.equal(
        backgroundLogPathOf(bgSurface),
        join(artifactDir, "subagent-logs", "worker-abc123.log"),
      );

      await closeBackground(bgSurface);
      await closeBackground(surface);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bg: pollForExit finds the sentinel in the log tail and reports exit-without-sentinel fail-closed", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();

      // Clean completion: the script's sentinel lands in the log; pollForExit
      // scans the log tail as the "screen" and returns the exit code.
      const doneScript = join(dir, "done.sh");
      writeFileSync(doneScript, "#!/bin/bash\necho working\necho '__SUBAGENT_DONE_0__'\n", { mode: 0o755 });
      const doneSurface = createBackgroundSurface("done-1", join(dir, "logs", "done.log"));
      launchBackground(doneSurface, doneScript);
      const done = await pollForExit(doneSurface, abortable(10_000), { interval: 20 });
      assert.equal(done.reason, "sentinel");
      assert.equal(done.exitCode, 0);

      // Crash: the child exits non-zero WITHOUT a sentinel → error outcome
      // with paneGone (so an interrupted child is classified as interruption
      // by the watcher's existing classification).
      const crashScript = join(dir, "crash.sh");
      writeFileSync(crashScript, "#!/bin/bash\nexit 3\n", { mode: 0o755 });
      const crashSurface = createBackgroundSurface("crash-1", join(dir, "logs", "crash.log"));
      launchBackground(crashSurface, crashScript);
      const crash = await pollForExit(crashSurface, abortable(10_000), { interval: 20 });
      assert.equal(crash.reason, "error");
      assert.equal(crash.paneGone, true);
      assert.match(crash.errorMessage ?? "", /exited with code 3 without completion sentinel/);

      await closeBackground(doneSurface);
      await closeBackground(crashSurface);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bg: a disappeared record fails closed after three strikes", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();
      const surface = createBackgroundSurface("ghost-1", join(dir, "logs", "ghost.log"));
      // No child was ever launched; closing (no live child) removes the record.
      await closeBackground(surface);
      assert.equal(hasBackgroundSurface(surface), false);

      const result = await pollForExit(surface, abortable(10_000), { interval: 20 });
      assert.equal(result.reason, "error");
      assert.equal(result.paneGone, true);
      assert.match(result.errorMessage ?? "", /disappeared before completion/);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bg: interrupt sends a group SIGINT; the watcher-visible outcome is an interruption (paneGone)", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();

      const sleepScript = join(dir, "sleep.sh");
      writeFileSync(sleepScript, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
      const surface = createBackgroundSurface("sleeper-1", join(dir, "logs", "sleeper.log"));
      launchBackground(surface, sleepScript);
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the child start

      const signalled = await interruptBackground(surface);
      assert.equal(signalled, true);

      // The group SIGINT kills bash and its sleep child; the child exits
      // non-zero without a sentinel → the fail-closed error outcome, tagged
      // paneGone so index.ts classifies it as an interruption (not a generic
      // error) when userInterrupted was set before the exit was read.
      const result = await pollForExit(surface, abortable(10_000), { interval: 20 });
      assert.equal(result.reason, "error");
      assert.equal(result.paneGone, true);
      assert.match(result.errorMessage ?? "", /without completion sentinel/);

      await closeBackground(surface);
      assert.equal(hasBackgroundSurface(surface), false);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("background surface backend: process hygiene and teardown", () => {
  // Plan D5 / risk-3: a detached grandchild (a background child's own bash
  // spawning `sleep … &`) survives the parent bash being killed unless the
  // close kills the WHOLE process group. launchBackground spawns with
  // detached:true (the bash child leads its own group) and closeBackground
  // signals -pid, so a group kill must take the detached grandchild down
  // with it. The assertions below are pid-based (no ambient process
  // counting): the script records the parent bash's pid and the detached
  // grandchild's pid in the log file, and the test verifies the two share a
  // process group BEFORE the close (so a group kill provably covers both)
  // and that both are dead AFTER it. A unique sleep duration keeps the
  // processes identifiable on a shared host and makes the test's own
  // processes easy to spot; the correctness of the check does not depend
  // on it.
  const UNIQUE_SLEEP = 613;

  function processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === "EPERM"; // EPERM = exists, not ours; ESRCH = gone
    }
  }

  /** The process-group id of a live pid (ps; null when it has exited). */
  function pgidOf(pid: number): number | null {
    try {
      const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
      const parsed = parseInt(out.trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  /** Poll up to `timeoutMs` until `predicate()` is true. Resolves with the final value. */
  async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      if (predicate()) return true;
      if (Date.now() - start > timeoutMs) return predicate();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Launch a real background surface (the facade's background backend, via
   * createSurface + sendLongCommand — the same seam index.ts uses). The
   * script records its own pid (the detached process-group leader) and the
   * pid of a DETACHED grandchild it spawns with `sleep UNIQUE_SLEEP &`, then
   * sleeps itself. Resolves once both pids are known and the grandchild is
   * observed alive.
   */
  async function launchWithDetachedGrandchild(dir: string): Promise<{
    surface: string;
    parentPid: number;
    grandchildPid: number;
  }> {
    const scriptDir = join(dir, "subagent-scripts");
    const scriptPath = join(scriptDir, "hygiene-1.sh");
    mkdirSync(scriptDir, { recursive: true });

    const surface = await createSurface("hygiene");
    assert.match(surface, /^bg:/, "a createSurface through the active backend must yield a bg: id");
    // The facade's log path for a caller-supplied script:
    // <scripts dir>/../subagent-logs/<base>.log
    const logPath = join(dir, "subagent-logs", "hygiene-1.log");
    sendLongCommand(
      surface,
      `echo "parent=$$" > '${logPath}'; sleep ${UNIQUE_SLEEP} & echo "grandchild=$!" >> '${logPath}'; sleep ${UNIQUE_SLEEP}`,
      { scriptPath },
    );

    // The log must accumulate (non-empty), then carry both pids.
    const readPids = (): { parentPid: number; grandchildPid: number } | null => {
      try {
        const text = readFileSync(logPath, "utf8");
        const parentMatch = text.match(/^parent=(\d+)$/m);
        const grandchildMatch = text.match(/^grandchild=(\d+)$/m);
        if (!parentMatch || !grandchildMatch) return null;
        return { parentPid: parseInt(parentMatch[1], 10), grandchildPid: parseInt(grandchildMatch[1], 10) };
      } catch {
        return null;
      }
    };
    const pidsReady = await pollUntil(() => readPids() !== null, 10_000);
    if (!pidsReady) throw new Error("pid lines were not written to the background log");
    const { parentPid, grandchildPid } = readPids()!;
    // Both processes must be alive before the close (the script has spawned
    // the grandchild and is still running).
    const bothAlive = await pollUntil(
      () => processExists(parentPid) && processExists(grandchildPid),
      10_000,
    );
    if (!bothAlive) throw new Error("parent bash and/or grandchild were not observed alive before the close");
    return { surface, parentPid, grandchildPid };
  }

  it("closeSurface kills the process group — a detached grandchild dies too (plan risk-3)", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();

      const { surface, parentPid, grandchildPid } = await launchWithDetachedGrandchild(dir);
      assert.ok(hasBackgroundSurface(surface), "registry must hold the live surface");
      // Structural precondition: the detached grandchild sits in the parent
      // bash's process group. This is what makes closeBackground's
      // `kill(-pid)` a group kill that MUST reach the grandchild — proving
      // the mechanism under test, not just its observed outcome.
      assert.equal(
        pgidOf(grandchildPid),
        parentPid,
        `grandchild pgid ${pgidOf(grandchildPid)} must equal the parent bash pid ${parentPid} (same process group)`,
      );

      await closeSurface(surface);

      // The close awaits the parent bash's exit; the grandchild (a separate
      // group member, reparented to init after the group SIGTERM) is reaped
      // moments later. Poll rather than assume a fixed wall-clock window.
      const parentGone = await pollUntil(() => !processExists(parentPid), 5_000);
      assert.ok(parentGone, `parent bash pid ${parentPid} must be dead after closeSurface`);
      const grandchildGone = await pollUntil(() => !processExists(grandchildPid), 5_000);
      assert.ok(grandchildGone, `detached grandchild pid ${grandchildPid} must be dead after closeSurface (group kill)`);
      assert.equal(hasBackgroundSurface(surface), false, "close removes the registry record");
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      // Defensive sweep: on failure the fail-closed retention semantics keep
      // the record (ownership must stay held), so clean it up explicitly.
      try { await closeAllBackgroundSurfaces(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clean completion: a detached grandchild is group-killed even after the wrapper exited", async () => {
    // The other variant above kills the group while the wrapper is still
    // running. This is the CLEAN-completion variant: the script spawns
    // `sleep ${UNIQUE_SLEEP} &` and then EXITS 0 on its own. The wrapper is
    // already gone by the time closeSurface runs (the already-exited path in
    // closeBackground), so the group SIGTERM would be skipped entirely —
    // and the detached grandchild (still in the wrapper's process group,
    // reparented to init) would survive its parent's CLEAN exit. closeBackground
    // therefore re-signals the group best-effort after the wrapper has exited;
    // this test proves the grandchild dies and the registry record is gone.
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();

      const scriptDir = join(dir, "subagent-scripts");
      const scriptPath = join(scriptDir, "clean-exit.sh");
      mkdirSync(scriptDir, { recursive: true });

      const surface = await createSurface("clean-exit");
      assert.match(surface, /^bg:/, "a createSurface through the active backend must yield a bg: id");
      const logPath = join(dir, "subagent-logs", "clean-exit.log");
      sendLongCommand(
        surface,
        `echo "parent=$$" > '${logPath}'; sleep ${UNIQUE_SLEEP} & echo "grandchild=$!" >> '${logPath}'; exit 0`,
        { scriptPath },
      );

      const readPids = (): { parentPid: number; grandchildPid: number } | null => {
        try {
          const text = readFileSync(logPath, "utf8");
          const parentMatch = text.match(/^parent=(\d+)$/m);
          const grandchildMatch = text.match(/^grandchild=(\d+)$/m);
          if (!parentMatch || !grandchildMatch) return null;
          return { parentPid: parseInt(parentMatch[1], 10), grandchildPid: parseInt(grandchildMatch[1], 10) };
        } catch {
          return null;
        }
      };
      const pidsReady = await pollUntil(() => readPids() !== null, 10_000);
      if (!pidsReady) throw new Error("pid lines were not written to the background log");
      const { parentPid, grandchildPid } = readPids()!;

      // Structural precondition, same as the in-flight test: the detached
      // grandchild shares the wrapper's process group, so a group signal is
      // what can reach it.
      assert.equal(
        pgidOf(grandchildPid),
        parentPid,
        `grandchild pgid ${pgidOf(grandchildPid)} must equal the parent bash pid ${parentPid} (same process group)`,
      );

      // Wait for the wrapper to CLEAN-exit on its own (record.exitCode set) —
      // the close must then take the already-exited path, not the in-flight
      // one.
      const wrapperExited = await pollUntil(() => backgroundExitCode(surface) != null, 10_000);
      assert.ok(wrapperExited, "the wrapper must exit 0 on its own before the close");
      assert.equal(backgroundExitCode(surface), 0, "the clean-exit script must have exited 0");
      // The grandchild outlives the wrapper (that is the bug under test).
      assert.ok(processExists(grandchildPid), "the detached grandchild must still be alive after the wrapper's clean exit");

      await closeSurface(surface);

      const parentGone = await pollUntil(() => !processExists(parentPid), 5_000);
      assert.ok(parentGone, `wrapper pid ${parentPid} must be dead after closeSurface`);
      const grandchildGone = await pollUntil(() => !processExists(grandchildPid), 5_000);
      assert.ok(grandchildGone, `detached grandchild pid ${grandchildPid} must be dead after closeSurface (post-exit group kill on clean completion)`);
      assert.equal(hasBackgroundSurface(surface), false, "close removes the registry record");
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      try { await closeAllBackgroundSurfaces(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeAllBackgroundSurfaces clears the registry and kills live children", async () => {
    const dir = createTestDir();
    const prevConfig = process.env.PI_SUBAGENT_BACKEND;
    try {
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();

      const { surface: liveSurface, parentPid, grandchildPid } = await launchWithDetachedGrandchild(dir);
      // A second, registry-only surface (no child launched): the sweep must
      // still drop its record.
      const quietSurface = createBackgroundSurface("quiet-1", join(dir, "logs", "quiet.log"));
      assert.ok(hasBackgroundSurface(liveSurface));
      assert.ok(hasBackgroundSurface(quietSurface));
      assert.ok(allBackgroundSurfaces().includes(liveSurface));

      await closeAllBackgroundSurfaces();

      // Both records are gone: the live child exited promptly on the group
      // SIGTERM (confirmed exit → record deleted), and the record-only
      // surface has no child to wait for.
      assert.equal(hasBackgroundSurface(liveSurface), false);
      assert.equal(hasBackgroundSurface(quietSurface), false);
      assert.ok(!allBackgroundSurfaces().includes(liveSurface));

      // The live child and its detached grandchild died with the group.
      const parentGone = await pollUntil(() => !processExists(parentPid), 5_000);
      assert.ok(parentGone, `parent bash pid ${parentPid} must be dead after the shutdown sweep`);
      const grandchildGone = await pollUntil(() => !processExists(grandchildPid), 5_000);
      assert.ok(grandchildGone, `grandchild pid ${grandchildPid} must be dead after the shutdown sweep`);
    } finally {
      if (prevConfig === undefined) delete process.env.PI_SUBAGENT_BACKEND;
      else process.env.PI_SUBAGENT_BACKEND = prevConfig;
      __setBackendForTest__(null);
      setConfigBackendPreference("auto");
      try { await closeAllBackgroundSurfaces(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("background surface backend: spawn wiring (plan steps 3-4)", () => {
  const testApi = (subagentsModule as any).__test__;

  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  // ── (a) Nested propagation: PI_SUBAGENT_BACKEND is pinned to the RESOLVED ──
  // backend (never "auto"), so a nested child never re-detects a different mux ──
  // from inherited HERDR-/TMUX-family markers (plan D3/D3.1, mandatory).
  it("nested propagation: a bg child inheriting HERDR_ENV still resolves+emits background (override beats detection)", () => {
    // Simulate the nested background child: it inherited HERDR_ENV=1 from its
    // herdr parent, but the parent pinned PI_SUBAGENT_BACKEND=background.
    const saved = {
      backend: process.env.PI_SUBAGENT_BACKEND,
      herdrEnv: process.env.HERDR_ENV,
      herdrPane: process.env.HERDR_PANE_ID,
    };
    try {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "w7:p1S0";
      process.env.PI_SUBAGENT_BACKEND = "background";
      __resetActiveBackendCacheForTest__();
      // The override is consulted BEFORE environment detection, so the
      // inherited HERDR_ENV does not misdirect the child's own nested spawns.
      const resolved = testApi.resolvedSpawnBackend();
      assert.equal(resolved, "background", "env override must beat inherited HERDR_ENV detection");
      assert.notEqual(resolved, "auto", "the propagated value must never be auto");
      // The launch builder emits that resolved value verbatim.
      const parts = testApi.buildSubagentLaunchEnvParts({
        resolvedAgentDir: null,
        name: "Worker",
        agent: "worker",
        grantSpawning: false,
        autoExit: false,
        sessionFile: "/s/worker.jsonl",
        id: "abc123",
        activityFile: "/s/art/worker-abc123.json",
        surface: "bg:abc123",
        backend: resolved,
        bashGuardMode: null,
      });
      assert.ok(parts.some((p: string) => p === "PI_SUBAGENT_BACKEND='background'"), `expected PI_SUBAGENT_BACKEND='background' in ${parts.join(" ")}`);
      assert.ok(!parts.some((p: string) => p === "PI_SUBAGENT_BACKEND='auto'"), "must never emit PI_SUBAGENT_BACKEND=auto");
    } finally {
      if (saved.backend === undefined) delete process.env.PI_SUBAGENT_BACKEND; else process.env.PI_SUBAGENT_BACKEND = saved.backend;
      if (saved.herdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = saved.herdrEnv;
      if (saved.herdrPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = saved.herdrPane;
      __setBackendForTest__(null);
    }
  });

  it("launch env builder honours the resolved backend verbatim (herdr case)", () => {
    const herdrParts = testApi.buildSubagentLaunchEnvParts({
      resolvedAgentDir: null, name: "W", agent: "w", grantSpawning: false, autoExit: false,
      sessionFile: "/s/w.jsonl", id: "x", activityFile: "/s/a.json", surface: "w7:p5", backend: "herdr", bashGuardMode: null,
    });
    assert.ok(herdrParts.some((p: string) => p === "PI_SUBAGENT_BACKEND='herdr'"), `expected PI_SUBAGENT_BACKEND='herdr' in ${herdrParts.join(" ")}`);
  });

  it("resume env builder pins PI_SUBAGENT_BACKEND to the re-resolved backend (resumed bg child stays bg)", () => {
    const parts = testApi.buildSubagentResumeEnvParts({
      agentDir: null, name: "Worker", sessionPath: "/s/worker.jsonl", id: "r1",
      activityFile: "/s/a.json", agent: "worker", spawnable: null, autoExit: true,
      backend: "background", bashGuardMode: null,
    });
    assert.ok(parts.some((p: string) => p === "PI_SUBAGENT_BACKEND='background'"), `expected PI_SUBAGENT_BACKEND='background' in ${parts.join(" ")}`);
    assert.ok(parts.some((p: string) => p === "PI_SUBAGENT_AUTO_EXIT=1"));
  });

  // ── (b) createSubagentSurface routing: background resolves to a plain surface ──
  // (shape key ignored) even in tabs mode — never a createSurfaceTab throw.  ──
  it("resolveSurfaceShape: background → plain; tabs top-level → tab; else pane", () => {
    const { resolveSurfaceShape } = testApi;
    // Background always plain, regardless of shape/depth.
    assert.equal(resolveSurfaceShape({ backendKind: "background", shape: "tabs", isSubagentSession: false }), "plain");
    assert.equal(resolveSurfaceShape({ backendKind: "background", shape: "panes", isSubagentSession: true }), "plain");
    // Multiplexer backends honour the existing tabs/panes + depth policy.
    assert.equal(resolveSurfaceShape({ backendKind: "tmux", shape: "tabs", isSubagentSession: false }), "tab");
    assert.equal(resolveSurfaceShape({ backendKind: "herdr", shape: "tabs", isSubagentSession: true }), "pane");
    assert.equal(resolveSurfaceShape({ backendKind: "tmux", shape: "panes", isSubagentSession: false }), "pane");
    assert.equal(resolveSurfaceShape({ backendKind: "herdr", shape: "panes", isSubagentSession: true }), "pane");
  });

  it("createSubagentSurface uses the plain createSurface for background even in tabs mode (no throw)", async () => {
    __setBackendForTest__(backgroundBackend);
    const prevSurface = process.env.PI_SUBAGENT_SPAWN_SURFACE;
    const prevSubagentSession = process.env.PI_SUBAGENT_SESSION;
    let surface: string | undefined;
    try {
      // Force "tabs" mode so a naive implementation would request a tab (and
      // background's createSurfaceTab would reject). It must not.
      process.env.PI_SUBAGENT_SPAWN_SURFACE = "tabs";
      delete process.env.PI_SUBAGENT_SESSION; // top-level session
      surface = (await testApi.createSubagentSurface("Worker", null, "/tmp")) as string;
      assert.match(surface, /^bg:/, "background resolution must yield a bg: id, not a tab/pane");
      assert.equal(kindOf(surface), "background");
    } finally {
      if (surface) { try { await closeBackground(surface); } catch {} }
      if (prevSurface === undefined) delete process.env.PI_SUBAGENT_SPAWN_SURFACE;
      else process.env.PI_SUBAGENT_SPAWN_SURFACE = prevSurface;
      if (prevSubagentSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
      else process.env.PI_SUBAGENT_SESSION = prevSubagentSession;
      __setBackendForTest__(null);
    }
  });

  // ── (c) Steering refusal (plan D4, decision 2) ──
  it("refuses to steer a running background child (bg: surface), no send attempted", () => {
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "bg:deadbeef" }));
      let sendAttempted = false;
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (_surface: string, _msg: string) => {
        sendAttempted = true;
      });
      assert.equal(sendAttempted, false, "no send may be attempted against a background child");
      assert.equal(result.details?.status, "background_not_steerable");
      assert.equal(result.details?.error, `background subagent "Worker" cannot be steered (no TUI); wait for completion and resume, or interrupt it`);
      assert.match(result.content[0].text, /background subagent "Worker" cannot be steered \(no TUI\)/);
      assert.match(result.content[0].text, /wait for completion and resume, or interrupt it/);
      // kindOf routing must not depend on the active backend for bg: ids.
      __setBackendForTest__(tmuxBackend);
      try {
        assert.equal(kindOf("bg:deadbeef"), "background");
      } finally {
        __setBackendForTest__(null);
      }
    } finally {
      runningMap.clear();
    }
  });

  it("steering a non-background running child still attempts the send (control case)", () => {
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "w7:p5" }));
      let sent: string | null = null;
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, msg: string) => {
        sent = msg;
      });
      assert.equal(result.details?.status, "steered");
      assert.equal(sent, "keep going", "a multiplexer child must still be steered");
    } finally {
      runningMap.clear();
    }
  });

  // ── (d) Completion message includes the log path for bg: surfaces ──
  it("completion/failure presentations include a 'Log:' line for background runs (and not for pane runs)", () => {
    const testApi2 = testApi;
    // Success.
    const ok = testApi2.resolveResultPresentation(
      { exitCode: 0, elapsed: 12, summary: "Done the thing.", backgroundLogPath: "/art/sess/subagent-logs/worker-a1.log" },
      "Worker",
    );
    assert.match(ok, /completed \(12s\)/);
    assert.match(ok, /Log: \/art\/sess\/subagent-logs\/worker-a1\.log/);
    // Non-zero exit.
    const fail = testApi2.resolveResultPresentation(
      { exitCode: 3, elapsed: 8, summary: "boom", backgroundLogPath: "/art/sess/subagent-logs/worker-a1.log" },
      "Worker",
    );
    assert.match(fail, /failed \(exit code 3\)/);
    assert.match(fail, /Log: \/art\/sess\/subagent-logs\/worker-a1\.log/);
    // No backgroundLogPath (a multiplexer run) → no Log: line.
    const pane = testApi2.resolveResultPresentation(
      { exitCode: 0, elapsed: 5, summary: "Fine." },
      "Worker",
    );
    assert.doesNotMatch(pane, /Log: /);
  });

  it("interruption notice includes the log line for background runs (and not for pane runs)", () => {
    const { formatInterruptedNotice } = testApi;
    const bg = formatInterruptedNotice("Worker", "main_agent", 40, "/art/sess/subagent-logs/worker-a1.log");
    assert.match(bg, /was interrupted by main_agent \(40s\)/);
    assert.match(bg, /Log: \/art\/sess\/subagent-logs\/worker-a1\.log/);
    const pane = formatInterruptedNotice("Worker", "main_agent", 40);
    assert.doesNotMatch(pane, /Log: /);
  });

  // ── First background spawn announces its log file (plan risk-1) ──
  it("noteBackgroundSpawn announces the log file once per session (then stays quiet)", () => {
    testApi.__resetBackgroundLogAnnouncementForTest__();
    const orig = console.info;
    const lines: string[] = [];
    console.info = (...args: any[]) => { lines.push(args.join(" ")); };
    try {
      testApi.noteBackgroundSpawn("Worker", "/art/sess/subagent-logs/worker-a1.log");
      testApi.noteBackgroundSpawn("Scout", "/art/sess/subagent-logs/scout-a2.log");
      assert.equal(lines.length, 1, "only the first background spawn may announce");
      assert.match(lines[0], /background subagent "Worker" runs headless/);
      assert.match(lines[0], /Log: \/art\/sess\/subagent-logs\/worker-a1\.log/);
    } finally {
      console.info = orig;
      testApi.__resetBackgroundLogAnnouncementForTest__();
    }
  });

  // ── Child side: isBackgroundChild (ask_question guard predicate) ──
  it("isBackgroundChild: true only for PI_SUBAGENT_BACKEND=background (case/whitespace tolerant)", () => {
    assert.equal(isBackgroundChild({ PI_SUBAGENT_BACKEND: "background" }), true);
    assert.equal(isBackgroundChild({ PI_SUBAGENT_BACKEND: " Background " }), true);
    assert.equal(isBackgroundChild({ PI_SUBAGENT_BACKEND: "tmux" }), false);
    assert.equal(isBackgroundChild({ PI_SUBAGENT_BACKEND: "herdr" }), false);
    assert.equal(isBackgroundChild({}), false);
    assert.equal(isBackgroundChild({ PI_SUBAGENT_BACKEND: "" }), false);
  });
});

// ── Post-session (stale-ctx) guard: the background-spawner crash ──
//
// In pi's print mode the runtime disposes the session after the first turn and
// invalidates the extension ctx: ANY subsequent `ctx`/`pi` access throws
// "extension ctx is stale". The `subagent` tool returns before turn 1 ends, so
// the fire-and-forget `watchSubagent(...).then/.catch` delivery can fire AFTER
// the invalidate — and an uncaught throw in that promise chain made the
// headless spawner exit 1, whose shutdown sweep then killed its own still-
// running grandchild. These tests prove the `sessionEnded` guard: post-session
// `updateWidget()` must not throw against a stale ctx, and the delivery
// catch/success paths must skip `pi.sendMessage` after shutdown.
describe("post-session (stale-ctx) guard", () => {
  const testApi = (subagentsModule as any).__test__;

  // A ctx that mirrors a REAL stale pi ctx: it throws on ANY property access
  // (pi's `assertActive()`), not just on one — so a guard that only checked one
  // property (or wrapped only one access in try/catch) would be caught here.
  function staleCtx(): any {
    return new Proxy(
      {},
      {
        get() {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      },
    );
  }

  afterEach(() => {
    testApi.setSessionEndedForTest(false);
    testApi.setWatchSubagentForTest(null);
    testApi.setLatestCtxForTest(null);
    (testApi.runningSubagents as Map<string, any>).clear();
  });

  it("updateWidget() does NOT throw post-shutdown even when latestCtx is stale", () => {
    const prev = testApi.setLatestCtxForTest(staleCtx());
    try {
      testApi.setSessionEndedForTest(true);
      // Must be a NO-OP, not a throw: the stale ctx would blow up on the first
      // property read, but the sessionEnded guard short-circuits before it.
      assert.doesNotThrow(() => testApi.updateWidget());
      // Negative control: with the guard DISARMED, the SAME stale ctx throws on
      // the hasUI read — proving the proxy really mirrors the stale-ctx hazard
      // and the test is not passing vacuously.
      testApi.setSessionEndedForTest(false);
      assert.throws(() => testApi.updateWidget(), /stale/);
    } finally {
      testApi.setLatestCtxForTest(prev);
      testApi.setSessionEndedForTest(false);
    }
  });

  it("session_shutdown flips the guard; session_start re-arms it (multi-session process)", () => {
    // A capturing api so we can fire the real handlers.
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    (subagentsModule as any).default({
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
      registerShortcut() {}, sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
    } as any);
    const fire = (e: string, ...a: any[]) => (handlers.get(e) ?? []).forEach((h) => h(...a));
    try {
      testApi.setSessionEndedForTest(false);
      fire("session_shutdown", {}, {});
      assert.equal(testApi.getSessionEnded(), true, "shutdown must arm the guard");
      fire("session_start", {}, {});
      assert.equal(testApi.getSessionEnded(), false, "a fresh session must re-arm delivery");
    } finally {
      fire("session_shutdown", {}, {}); // leave the flag set=false-safe for other tests
      testApi.setSessionEndedForTest(false);
    }
  });

  it("delivery .catch skips pi.sendMessage after session shutdown (stale ctx, no throw)", async () => {
    const root = createTestDir();
    const sent: Array<{ surface: string; command: string }> = [];
    // A minimal fake backend (this module-scope describe cannot reach the
    // one defined inside the bash-guard describe block above): records the
    // command and creates a fake pane.
    __setBackendForTest__({
      kind: "tmux",
      available: () => true,
      createSurface: async () => "fake-pane-1",
      createSurfaceTab: async () => "fake-tab-1",
      sendLongCommand: (surface: string, command: string) => {
        sent.push({ surface, command });
        return "fake-script.sh";
      },
      sendCommand: (surface: string, command: string) => sent.push({ surface, command }),
      readScreen: () => "",
      readScreenAsync: async () => "",
      closeSurface: () => {},
      labelSurface: () => {},
      sendMessage: () => {},
    } as any);
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const tools: any[] = [];
    const sentMessages: any[] = [];
    const api = {
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool(t: any) { tools.push(t); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      sendUserMessage() {},
      sendMessage(m: any) { sentMessages.push(m); },
      getAllTools() { return []; },
    } as any;
    (subagentsModule as any).default(api);
    const subagentTool = tools.find((t) => t.name === "subagent");
    const ctx = {
      sessionManager: {
        getSessionFile: () => join(root, "sess.jsonl"),
        getSessionId: () => "sess-1",
        getSessionDir: () => join(root, "sessions"),
      },
      cwd: root,
    } as any;
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sess.jsonl"), JSON.stringify(SESSION_HEADER) + "\n");
    try {
      await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "stale-deliver", "name: stale-deliver\ntools: read, bash");
        // Controllable watcher: returns a promise that settles only when
        // rejectWatcher() is called below, so the .catch timing is
        // deterministic (it fires AFTER the shutdown + stale-ctx swap).
        let rejectWatcher: (e: Error) => void = () => {};
        testApi.setWatchSubagentForTest(
          (() => new Promise((_res, rej) => { rejectWatcher = rej; })) as any,
        );
        // Spawn with a VALID ctx: startWidgetRefresh() (which reads
        // latestCtx.hasUI during the launch) must not trip on a stale proxy.
        const res = await subagentTool.execute("c1", { agent: "stale-deliver", name: "StaleDeliver", task: "t" }, undefined, undefined, ctx);
        assert.equal(res.details?.status, "started", res.content[0]?.text);
        // The session shuts down while the (injected) watcher is still pending.
        (handlers.get("session_shutdown") ?? []).forEach((h) => h());
        assert.equal(testApi.getSessionEnded(), true, "shutdown must arm the guard");
        // Swap in the STALE ctx (mirrors pi's post-invalidate state), then
        // reject the watcher so the delivery .catch runs in the stale state.
        const prevCtx = testApi.setLatestCtxForTest(staleCtx());
        try {
          rejectWatcher(new Error("Aborted while waiting for subagent to finish"));
          await new Promise((r) => setTimeout(r, 5)); // let the .catch microtask run
          // The catch path must NOT have delivered into the stale pi (it would
          // throw "stale" → unhandled-reject → exit 1). No steer was sent.
          assert.equal(sentMessages.length, 0, "no steer may be delivered after session shutdown");
        } finally {
          testApi.setLatestCtxForTest(prevCtx);
        }
      });
    } finally {
      testApi.setWatchSubagentForTest(null);
      (handlers.get("session_shutdown") ?? []).forEach((h) => h());
      testApi.setSessionEndedForTest(false);
      (testApi.runningSubagents as Map<string, any>).clear();
      __setBackendForTest__(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
