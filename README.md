# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in **herdr** or **tmux** panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux + herdr fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own pane — a split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

The pane host is auto-detected: **herdr** (when pi runs inside herdr) or **tmux**, whichever environment the parent session lives in. When neither is available — or when background mode is selected — subagents run headless with output captured to a log file instead of a pane (see [Background mode](#background-mode)).

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  s2-worker  waiting 2m · own children        │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension rebalances after every spawn and exit (debounced).

- **tmux** — re-applies a named layout; the constant `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` defaults to `even-horizontal` (change it to any named tmux layout: `main-vertical`, `tiled`, …).
- **herdr** — recomputes the tab's split tree and sets each split's ratio to its pane count via the herdr socket API (`layout.set_split_ratio`), which resizes in place: no tab/pane ids are recreated and focus is untouched (see `applyEvenLayout` in `pi-extension/subagents/herdr.ts`).

In herdr, the split direction follows the parent pane's geometry: a wide parent pane (more than two columns per row) splits right, a narrow or tall one splits down. Override per run with `PI_SUBAGENT_SPLIT_DIRECTION=right|down|auto` (default `auto`). In tmux the split is always horizontal; the `even-horizontal` rebalance above keeps the panes balanced.

Each subagent's pane is labelled with its name in the herdr sidebar (tmux: pane title).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

### Layout: panes vs tabs

By default every spawn splits a **pane** off the caller's pane, so a burst of subagents crowds one window. Opt in to **tabs** in `config.json` (copy `config.json.example`) and each first-level subagent opens in its own, labelled tab instead:

```json
{
  "status": { "enabled": true },
  "spawn": { "surface": "tabs" }
}
```

- **`spawn.surface: "panes"`** (default) - current behaviour: a pane split off the caller.
- **`spawn.surface: "tabs"`** - a first-level subagent opens in a new tab labelled with the subagent's name. If that subagent spawns children, they split off as **panes inside the subagent's tab** (not further tabs), so a subagent and its children stay together while the main window stays uncluttered.

Tabs and panes are always created **without stealing focus** (`tmux new-window -d` / `herdr tab create --no-focus`). A tab is closed with the subagent: killing its last pane auto-closes the whole tab/window in both tmux and herdr. An empty tab can also just be closed by hand.

`PI_SUBAGENT_SPAWN_SURFACE` (`panes` or `tabs`, case-insensitive) overrides the config value for a single run, without editing `config.json`:

```bash
export PI_SUBAGENT_SPAWN_SURFACE=tabs
```

### Background mode

When no terminal multiplexer is available — or when it is explicitly selected — subagents run **headless**: the child `pi` process runs detached with its output appended to a log file, and no pane is created. The log lives at `artifacts/<sessionId>/subagent-logs/<name>-<id>.log` (beside the child's launch scripts), and every completion, failure, and interruption message names it in a `Log: <path>` line. The first headless spawn in a session also logs the path once via `console.info`.

**`auto` never errors.** Backend resolution is `PI_SUBAGENT_BACKEND` env override → `spawn.backend` config → environment detection (herdr → tmux) → **background floor**. A bare environment that used to refuse with "a terminal multiplexer is required" now spawns headless instead. An explicit `herdr` or `tmux` that is unavailable is still an error, naming the setup.

- **`spawn.backend`** in `config.json` — `"auto"` (default), `"herdr"`, `"tmux"`, or `"background"`. When the resolved backend is herdr or tmux, `spawn.surface` (`panes`/`tabs`) decides the shape as above; it is **ignored** for `background`.
- **`PI_SUBAGENT_BACKEND`** env override — same values, checked before the config. It is also **propagated to children**: each spawn pins the child to the backend the parent resolved (never `auto`), and the child consults the override before environment detection. This is what keeps nested spawns from re-detecting a different multiplexer inherited from the parent (e.g. a background child spawned by a herdr session spawning its own children as herdr panes off the grandparent's pane).

v1 limitations (a background child has no TUI):

- **Steering is refused.** `subagent_message` to a *running* background child returns `background subagent "<name>" cannot be steered (no TUI); wait for completion and resume, or interrupt it`. Resume-after-completion works as usual and re-resolves the surface (a headless session resumed while a multiplexer is available appears there).
- **`ask_question` is unavailable** in background children — there is no pane to deliver the orchestrator's reply into, so the tool would park the session forever. (It is also omitted from the child's `--tools` allowlist, so the two sides agree.)
- **`subagent_interrupt` works** via the process kill (SIGINT to the child's process group, then close).
- **A background child that spawns its own children reports at spawn time.** The child is a print-mode `pi`, which disposes the session after its first turn — so a background *spawner* completes the moment its own child is launched (its completion steer is an "interim report"), and its shutdown sweep kills the still-running grandchild (the grandchild's log exists but stays empty). Nested results are recovered via `subagent_message` resume of the grandchild.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated pane/tab, or headless (async) |
| `subagent_interrupt` | Cancel a running sub-agent by exact `id` or `name` — terminates its process and closes its pane |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

`safe_bash` was removed (2026-10-19); replaced by `bash` + `bash-guard-mode`.

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Omit to auto-generate a unique name (suffixed on collision). An explicit name must not collide with a subagent already running or finished in this session, or the spawn is refused |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** - the message is delivered to the live pane and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** - the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

When pi runs in herdr, steering a running subagent goes through the agent surface (`herdr agent prompt`): the message respects bracketed paste, so multi-line messages arrive as one turn. If the child is sitting at an approval or question dialog, the steer is refused with a clear error (`agent_blocked`) instead of being typed over it. Outside herdr (or before herdr has recognised an agent in the pane), it falls back to typing the message into the pane (flattened to one line, since each newline there would submit a partial turn).

Steering restricted subagents in herdr relies on the herdr-managed pi integration extension (`~/.pi/agent/extensions/herdr-agent-state.ts`), which herdr installs when the pi integration is set up. Restricted children launch with `--no-extensions` (see [Tool access control](#tool-access-control)), so the extension is re-enabled for them automatically at spawn time. If the file is absent, steering degrades to the raw-pane fallback above.

### Interrupting

`subagent_interrupt` cancels a running sub-agent addressed by exact `id` or `name` (exactly one of the two):

```typescript
subagent_interrupt({ name: "scout" });
```

This is cancellation, not a pause: the run is marked interrupted **before** the signal goes out, then Escape is sent to stop the in-flight turn (herdr: `pane send-keys esc`; tmux: `send-keys Escape`), the child process is terminated, the pane is closed, and the widget entry disappears. The watcher then steers **one** concise interruption notice (`customType: subagent_result` with `details.interrupted: true` and `details.interruption: { actor, requestedAt }`) instead of the full completion result, and no result follows. Interrupting a target that is not currently running (unknown `id`/`name`, or one that already finished) returns a clear error — aborts of finished handles are errors, never interruptions, so a run that completed normally a moment earlier is reported as completed, not interrupted. A child that finishes on its own while the interrupt is in flight is classified by that race: a torn-down pane (no terminal sentinel) is interrupted; an observed clean exit is a normal completion.

**Actor attribution** is captured from the caller's environment, never from tool arguments: `actor` is `main_agent` when a top-level session interrupts, or the interrupting sub-agent's own runtime name (its `PI_SUBAGENT_NAME`) when a sub-agent cancels one of its children. Steering a handle that is interrupting or interrupted is refused with a clear error ("was interrupted and is shutting down").

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Names are unique **per spawner session**: spawning with a name that is already running, in flight, or already finished in the session is refused with a pointer to `subagent_message` (the name is the only address for steering/resuming, so a duplicate would strand both subagents behind an ambiguous handle). Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `litellm/coding` (fast, no thinking) | `read`, `grep`, `find`, `ls`, `bash`, `codemode` | Fast read-only codebase recon (guarded read-only via bash-guard) |
| **researcher** | `litellm/coding-reasoning` (medium thinking) | `web_search`, `web_fetch`, `codemode` | Web research, synthesized into a sourced brief. No workspace access: queries and URLs are the only thing that leaves the machine |
| **worker** | `litellm/coding-reasoning` (xhigh thinking) | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch`, `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`), carry their identity in the system prompt (`system-prompt: append`), and set `model-fallback: inherit` — if the primary run fails (provider/agent error, non-zero exit, or no assistant text), the spawn is retried once on the spawner's live model (see [Model fallback](#model-fallback)).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: litellm/coding-reasoning
model-fallback: inherit
thinking: medium
tools: read, grep, find, ls, bash, web_search
bash-guard-mode: read-only
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Primary/default model |
| `model-fallback` | string | Optional one-shot fallback model: `inherit` (copies the immediate spawner's live model) or a concrete `provider/model[:thinking]`. Absent = no fallback (custom agents stay opt-in). Invalid values are a spawn error naming the raw value and the source file |
| `thinking` | string | `minimal`, `low`, `medium`, `high`, or `xhigh` (levels the model's `thinkingLevelMap` does not support are clamped) |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `video_extract`, `youtube_search`, `google_image_search`. Grantable pi builtin extensions (loaded into the child via `-e builtin:<name>`, distinct from the built-in tool list above): `codemode` and `tool_search`. Only the extensions backing the listed tools are loaded into the child |
| `bash-guard-mode` | string | Bash-guard mode for this agent's child: `off`, `prompt`, `floor`, or `read-only` (case-insensitive). Validated at spawn — a bad value is a spawn error naming the raw value and the source file (`agent <name> has invalid bash-guard-mode '<raw>' (expected off, prompt, floor, or read-only) in <file>`). The value is snapshotted into the loadout, so a resume replays the mode even if the agent file changed in the meantime. An explicit value wins over bash-guard's own `PI_SUBAGENT_SESSION` heuristic; an absent field leaves the heuristic in force (subagent → full floor). Fail-closed: a mode that requires the guard (`read-only`, `floor`, `prompt`) refuses to spawn when bash-guard is not among the resolved always-on extensions (`agent <name> sets bash-guard-mode: <mode> but bash-guard is not in the resolved always-on extensions (resolved: <paths or none>); install it and add it to alwaysOnExtensions (config.json) or always-on-extensions (agent frontmatter)`), and a `cli: claude` agent cannot use any mode (`bash-guard-mode requires the pi CLI (the guard is a pi extension); agent <name> cannot use it with cli: claude`). `off` never requires the guard |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_interrupt`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `always-on-extensions` | string | Comma-separated extension paths loaded into this agent's child in addition to the global `alwaysOnExtensions` config (see [Always-on extensions](#always-on-extensions)). Absolute or `~/` paths; a leading `-` excludes a matching global entry |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### Model fallback

`model-fallback` is attempted **once** when the primary run reports a provider/agent error, exits non-zero, or exits without any non-whitespace assistant text. The failed child's session file and loadout are retained in the parent's artifacts untouched (its `.exit` sidecar is consumed by the watcher, which deletes it right after reading it), and a fresh child starts from the original task under the same display name. User cancellation (`subagent_interrupt`) **never** triggers the fallback — interrupted runs are reported as interrupted, with no result. A fallback that resolves to the same model and thinking level as the failed primary run is skipped (the primary result is reported as-is, with a skip note when the primary failed).

The retry's result is final — one-shot: no second fallback even if the retry fails (its error is reported normally). With `model-fallback: inherit`, the fallback model is the **immediate** spawner's live model (a nested spawner inherits down the chain), not the top-level session. Thinking resolves in this order: the primary run's thinking level, then the spawner's live level, then the fallback spec's own `:thinking`. The fallback model and thinking are frozen in the retry's `<session>.loadout.json`, so later `subagent_message` resumes replay the fallback selection — the same invariant as "resume replays the original sandbox". The completion steer attributes the fallback (`details.modelFallback: { from, to, reason, failedSessionFile }` and a `model fallback: X → Y` line) so the orchestrator sees which model produced the result.

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns). The parked state reports its reason: the child records a `waitingReason` (`ask_question` or `own_children`) in its activity file, and the widget annotates the row accordingly (see [Status widget & configuration](#status-widget--configuration)).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot. This includes grantable builtin extensions: listing `codemode` loads it via `-e builtin:codemode` and nothing else — codemode grants no extra tools of its own, its scripts still only get what the allowlist gives (and its nested calls go through the same pipeline, so always-on guards gate them too).

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). Presence of that field also grants the spawning toolset (`subagent`, `subagent_interrupt`, `subagent_message`, `subagents_list`) — so a sub-agent can interrupt its own children, with the interruption notice attributed to its runtime name. There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

### Always-on extensions

Always-on extensions are loaded into **every** sub-agent process in addition to the extensions backing its `tools` list. The default configuration is `bash-guard`, whose headless hard-block floor keeps autonomous sub-agents from running catastrophic bash commands.
Without this, a restricted child would run `bash` with no guard at all.

```json
{
  "alwaysOnExtensions": {
    "paths": ["~/.pi/agent/extensions/bash-guard"]
  }
}
```

- The config list applies to all sub-agents; the agent frontmatter field `always-on-extensions` adds role-specific entries on top of it.
- Frontmatter entries are ADDITIVE by default; a leading `-` makes one SUBTRACTIVE: it removes the matching global `alwaysOnExtensions` entry for that agent only (e.g. global config loads bash-guard for every sub-agent, and `always-on-extensions: -~/.pi/agent/extensions/bash-guard` on one agent opts that role out). Matching is by canonical path, so `~/...` and absolute forms (and symlinks) all match. An exclusion that matches nothing warns at spawn time.
- Entries are extension directories (a `package.json` with a `pi.extensions` manifest, or an `index.ts`/`index.js`) or single extension files. Paths must be absolute or `~/`-prefixed (config.json is package-local, so relative paths are rejected).
- A missing entry does not break the spawn: it is dropped with a console warning at launch. The list is re-resolved at every spawn and resume, so `~/` entries track the home directory the launch runs under.
- Per-agent entries (additions and exclusions) are snapshotted into the loadout sidecar and replayed on resume, exactly like the tool allowlist.
- **Per-agent mode selection.** Loading bash-guard for every sub-agent is the floor; the `bash-guard-mode` frontmatter field (see [Frontmatter reference](#frontmatter-reference)) selects the mode for each agent, so read-only roles (scout) run `read-only` while the rest keep the default.
- **Compatibility.** `read-only` mode requires a bash-guard that has the mode framework.
Older installed versions ignore `PI_BASH_GUARD_MODE` and degrade to the full floor, which is safe (more restrictive than `read-only`, never looser).
- **Verified live on pi 1.3.0.** Codemode's nested `tools.bash()` calls go through the same extension tool pipeline (pi's `ctx.executeTool`), so bash-guard gates them too: `test/integration/subagent-codemode.test.ts` spawns a read-only-guarded child, and the child's codemode script's nested write command is refused by the guard (`[bash-guard read-only] redirection to "…" is not allowed in read-only mode`) while the file is never created.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). A `waiting` row can carry a reason annotation from the activity file's `waitingReason`: `waiting 2m · question` — an `ask_question` is pending the orchestrator's reply — or `waiting 2m · own children` — the sub-agent is parked on its own child sub-agents' results. A higher-priority state label (`interrupted`, `done`) takes the annotation slot instead. Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages (and status/question messages) expand when you click them, or with `Ctrl+O` to toggle everything. The `subagent` / `subagent_message` tool blocks expand the same way — a click or `Ctrl+O` reveals the full task / message, collapsing back to the one-line preview.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true },
  "spawn": { "surface": "panes", "backend": "auto" },
  "alwaysOnExtensions": { "paths": ["~/.pi/agent/extensions/bash-guard"] }
}
```

- `status.enabled` - show the per-sub-agent status widget (see above).
- `spawn.surface` - `"panes"` (default) or `"tabs"`; see [Layout: panes vs tabs](#layout-panes-vs-tabs).
- `spawn.backend` - `"auto"` (default), `"herdr"`, `"tmux"`, or `"background"`; see [Background mode](#background-mode). `auto` never errors — it falls to headless background execution when no multiplexer is available.
- `alwaysOnExtensions.paths` - extension directories/files loaded into every sub-agent process regardless of its `tools` list (see [Always-on extensions](#always-on-extensions)). The recommended default is `["~/.pi/agent/extensions/bash-guard"]`, shown in `config.json.example`.

## Installation

This repository is a [pi-package](https://pi.dev/packages), so it can be installed directly:

```bash
pi install /path/to/pi-interactive-subagents
```

Or link/copy the extension into your user extensions directory (the bundled agents and `config.json.example` resolve relative to the package root, so the whole repo must stay reachable from the linked directory):

```bash
ln -s /path/to/pi-interactive-subagents/pi-extension/subagents ~/.pi/agent/extensions/pi-interactive-subagents
```

Verify with a fresh pi session: `subagents_list` should show `scout`, `researcher`, and `worker`.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) `>=1.0.0`
- A terminal multiplexer — [herdr](https://herdr.dev) (preferred, auto-detected) or [tmux](https://github.com/tmux/tmux) — is needed for pane-based subagents, but **no longer required**: with none available, `auto` falls back to headless [background mode](#background-mode).

```bash
# herdr — just run pi inside it
herdr

# or tmux
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is itself a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — the project that originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
