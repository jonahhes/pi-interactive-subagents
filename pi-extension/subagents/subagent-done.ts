/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their run fully settles (see the `agent_settled` gate);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Text,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder, type SubagentWaitingReason } from "./activity.ts";
import { claimLeftClick } from "./mouse-toggle.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Which park reason applies when the `agent_settled` gate parks a subagent
 * (instead of letting it exit). Recorded as the activity file's
 * `waitingReason` so the parent can tell the two waits apart.
 *
 * Q1 priority: when BOTH an unanswered `ask_question` and pending children are
 * true, `ask_question` wins the single label slot — it is the actionable wait.
 * An aborted run records no reason (the session is left open for inspection,
 * not parked on a pending work item).
 */
export function resolveWaitingReason(
  aborted: boolean,
  awaitingAnswer: boolean,
  hasPendingChildren: boolean,
): SubagentWaitingReason | null {
  if (aborted) return null; // aborted park — no reason to show
  // Q1 priority: the actionable reason (question) wins the single label slot.
  if (awaitingAnswer) return "ask_question";
  if (hasPendingChildren) return "own_children";
  return null;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * True when this process is a BACKGROUND (headless) subagent child.
 *
 * Read at registration time. The parent pins `PI_SUBAGENT_BACKEND` to the
 * backend it RESOLVED for this child (never `"auto"` — see
 * `resolvedSpawnBackend()` in index.ts), so a background child never
 * re-detects a multiplexer from inherited `HERDR_`/`TMUX`-family markers and
 * never gets a TUI.
 *
 * Used to withhold `ask_question`: such a child has no pane for the
 * orchestrator's reply to be steered back into, so the tool would park the
 * session forever (a silent deadlock — plan decision 2). The parent also
 * omits it from the child's `--tools` allowlist, so the two sides agree.
 */
export function isBackgroundChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_BACKEND?.trim().toLowerCase() === "background";
}

/**
 * Persistent "subagent-tools" widget mounted above the subagent's editor.
 *
 * pi's `setWidget` invokes the factory ONCE to produce the mounted component,
 * so the display must be rebuilt from live extension state (tool list,
 * denied tools, `expanded`) on every `render(width)` call. Baking the `Text`
 * in at mount time (as the old inline factory did) would freeze the display
 * until the widget is re-registered, which is exactly why the old widget
 * only changed when the shortcut re-called `setWidget`.
 *
 * `handleMouse` claims plain left clicks via the shared `claimLeftClick`
 * (see mouse-toggle.ts for the dispatcher mechanics): the TUI synthesizes a
 * `click` event on a no-drag left-button release, the returned
 * `{ handled: true }` stops the event from reaching text selection and makes
 * the TUI re-render, which picks up the new `expanded` value. All other
 * mouse input is ignored, so selection drags and right-click paste keep
 * working as on any other rendered line.
 */
class SubagentToolsWidget implements Component {
  private theme: any;
  private renderBody: (theme: any) => string;
  private onToggle: () => void;

  constructor(theme: any, renderBody: (theme: any) => string, onToggle: () => void) {
    this.theme = theme;
    this.renderBody = renderBody;
    this.onToggle = onToggle;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return claimLeftClick(event, this.onToggle);
  }

  render(width: number): string[] {
    const box = new Box(1, 0, (text: string) => this.theme.bg("toolSuccessBg", text));
    box.addChild(new Text(this.renderBody(this.theme), 0, 0));
    return box.render(width);
  }

  invalidate(): void {
    // All display state lives in the extension closure, read live at render
    // time; there is nothing cached here to invalidate.
  }
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  /**
   * The widget's body (ANSI string) from LIVE state - re-evaluated on every
   * render so the mounted component reflects the current tool list, denied
   * tools, and `expanded` without re-registering.
   */
  function buildWidgetBody(theme: any): string {
    const label = subagentAgent || subagentName;
    const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

    if (expanded) {
      // Expanded: full tool list + denied
      const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
      const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

      const toolList = toolNames
        .map((name: string) => theme.fg("dim", name))
        .join(theme.fg("muted", ", "));

      let deniedLine = "";
      if (denied.length > 0) {
        const deniedList = denied
          .map((name: string) => theme.fg("error", name))
          .join(theme.fg("muted", ", "));
        deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
      }

      return `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`;
    }

    // Collapsed: one-line summary
    const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
    const deniedInfo =
      denied.length > 0
        ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
        : "";
    const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

    return `${agentTag}${countInfo}${deniedInfo}${hint}`;
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        // The mounted component renders live state (see SubagentToolsWidget),
        // so the widget only needs registering once per session; the shortcut
        // still re-registers, which is harmless and refreshes the theme ref.
        return new SubagentToolsWidget(theme, buildWidgetBody, () => {
          expanded = !expanded;
        });
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Stashed from the latest `agent_end` turn: the stopReason of the last
  // assistant message in that turn. `agent_settled` carries NO messages
  // (only `{ aborted }`), so the park/exit gate reads this stashed value to
  // apply the same stopReason === "aborted" rule the old `agent_end` gate
  // applied to `event.messages` directly.
  let latestStopReason: string | undefined;
  // Stashed from the latest `agent_end` turn via findLatestAssistantError()
  // (re-evaluated on every agent_end — null when the latest assistant
  // message is not an error). The .exit sidecar is deliberately NOT written
  // at agent_end: a turn can end with stopReason "error" while the session
  // then PARKS (awaitingAnswer or children still running), and a sidecar on
  // disk in that case would trip the parent's pollForExit .exit fast path
  // (surface.ts) into an early reason:"error" while the child is alive.
  // The settled exit branch below writes it only when we actually exit.
  let latestErrorInfo: SubagentErrorInfo | null = null;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    const messages = (event as any).messages as any[] | undefined;
    // Message inspection only. The park/exit gate lives on `agent_settled`,
    // which fires once the run has fully settled (no retry, compaction, or
    // queued continuation will run) and carries NO messages (only
    // `{ aborted }`). We stash the latest assistant stopReason here so the
    // gate can still apply the stopReason rule to this turn's messages.
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const msg = messages![i];
      if (msg?.role === "assistant") {
        latestStopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
        break;
      }
    }

    // Stash the turn's error info (re-evaluated on every agent_end, null when
    // the latest assistant message is not an error) for the `agent_settled`
    // exit branch, which writes the .exit sidecar. The sidecar is
    // deliberately deferred there so a parked error turn does not trip the
    // parent's pollForExit .exit fast path (see surface.ts) into an early
    // reason:"error" while this child is still alive.
    latestErrorInfo = findLatestAssistantError(messages);

    recorder.agentEndWaiting();
  });

  // Owns the park/exit gate. `event.aborted` is true when the run ended
  // because it was aborted (e.g. Escape) — such runs must not auto-exit
  // (they leave the session open for inspection or another prompt). This
  // event carries NO messages (only `{ aborted }`), so the stopReason rule
  // is applied via `latestStopReason`, stashed by the `agent_end` handler
  // above (same rule the old gate applied to `event.messages`).
  // NOTE (verified by spike on pi 1.3.0): `agent_settled` can fire while this
  // session still has children running (runningChildrenCount() > 0), before
  // their results land as steered turns. The hasPendingChildren guard
  // handles exactly that — it parks the session (as the old `agent_end`
  // gate did) until the children finish and their results are delivered, at
  // which point a later settled event exits cleanly.
  pi.on("agent_settled", (event, ctx) => {
    // Never shut down while this session still has work in flight:
    //  - event.aborted: the run was aborted (Escape / user cancel).
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - hasPendingChildren: this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    //  - latestStopReason "aborted": the turn's last assistant message was
    //    aborted (preserves the exact rule the old gate applied).
    // In the park cases the session stays open and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !event.aborted &&
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, [{ role: "assistant", stopReason: latestStopReason }]);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      // Only written here, on the actual exit path, so a parked error turn
      // (awaitingAnswer / children running) can never trip the .exit fast
      // path in surface.ts while the child is still alive.
      if (latestErrorInfo) {
        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        if (sessionFile) {
          try {
            writeFileSync(
              `${sessionFile}.exit`,
              JSON.stringify({
                type: "error",
                errorMessage: latestErrorInfo.errorMessage,
                stopReason: latestErrorInfo.stopReason,
              }),
            );
          } catch {
            // Best effort — even without the sidecar, watcher's session-file
            // fallback can still recover the errorMessage.
          }
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    // Park path: record WHY the session is staying open (D5 — interactive
    // children park identically, so this is outside the autoExit block).
    recorder.setWaitingReason(resolveWaitingReason(event.aborted, awaitingAnswer, hasPendingChildren));

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  // D4: `ask_question` is WITHHELD in background children (no TUI → no reply-
  // delivery path → a parked session would deadlock). The parent omits it from
  // the child's `--tools` allowlist too, so both sides agree. In multiplexer
  // children the registration below is unchanged.
  if (!isBackgroundChild()) {
    pi.registerTool({
      name: "ask_question",
      label: "ask_question",
      description:
        "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
        "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
        "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
        "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
        "Ask exactly one question per call; make separate calls for unrelated questions.",
      promptSnippet:
        "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
      promptGuidelines: [
        "Ask exactly one question per tool call.",
        "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
        "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
        "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
        "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
        "After asking, stop and wait — the reply will arrive as your next message.",
      ],
      parameters: Type.Object({
        question: Type.String({
          description:
            "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        if (!sessionFile) {
          throw new Error(
            "ask_question is only available in subagent contexts. " +
              "PI_SUBAGENT_SESSION environment variable is not set.",
          );
        }

        // Keep the session open: suppress auto-exit for this turn and park in the
        // "waiting" phase. The parent's watcher picks up the `.ask` signal and
        // notifies the orchestrator, who replies via subagent_message.
        awaitingAnswer = true;
        recorder.askQuestion();
        const askData = {
          name: process.env.PI_SUBAGENT_NAME ?? "subagent",
          agent: process.env.PI_SUBAGENT_AGENT ?? "",
          question: params.question,
        };
        writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData));

        return {
          content: [
            {
              type: "text",
              text:
                "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
                "assume an answer. Their reply will arrive as your next message.",
            },
          ],
          details: { question: params.question },
        };
      },

      renderCall(args, theme) {
        const text =
          theme.fg("toolTitle", theme.bold("ask_question ")) +
          theme.fg("muted", String((args as any).question ?? ""));
        return new Text(text, 0, 0);
      },
    });
  }

}
