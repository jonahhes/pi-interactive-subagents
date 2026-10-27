/**
 * Background surface backend for the subagent surface layer.
 *
 * A background surface is a HEADLESS subagent: the launch script runs in a
 * detached bash child whose stdout/stderr append to a log file, and there is
 * no pane or tab to manage. index.ts only ever imports this file through
 * surface.ts (the MuxBackend facade); the per-multiplexer implementations
 * live in herdr.ts and tmux.ts.
 *
 * Surface ids are prefixed `bg:` so the facade can route surface-scoped
 * operations to this backend regardless of which multiplexer (if any) hosts
 * the parent pi process.
 *
 * Process hygiene: `launchBackground` spawns with `detached: true`, so the
 * bash child leads its own process group. close/interrupt therefore signal
 * the WHOLE group (`process.kill(-pid, …)`) — signalling only the bash
 * process would orphan the pi child it runs in the foreground. Our pane-path
 * launch scripts carry no trap/protocol wrapper (unlike the pane paths), so
 * a group kill hits the bash script and the pi child in one shot.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface BackgroundSurface {
  child: ChildProcess | null;
  exitCode: number | null;
  logPath: string | undefined;
}

/**
 * Module-level registry of live background surfaces. Fail-closed ownership
 * note: a record is only removed by `closeBackground` on a CONFIRMED exit —
 * a close that times out retains the record so a later retry (or the
 * session_shutdown sweep) can still reach the child. A record must never be
 * dropped on failure: the process it names would become unmanageable.
 */
const surfaces = new Map<string, BackgroundSurface>();

export function createBackgroundSurface(id: string, logPath: string | undefined): string {
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const surface = `bg:${id}`;
  surfaces.set(surface, { child: null, exitCode: null, logPath });
  return surface;
}

export function launchBackground(surface: string, scriptPath: string): void {
  const record = surfaces.get(surface);
  if (!record) throw new Error(`Unknown background surface: ${surface}`);
  if (!record.logPath) throw new Error(`Background surface ${surface} has no log path registered`);
  const fd = openSync(record.logPath, "a");
  // `detached: true` makes the bash child a process-group leader so
  // close/interrupt can kill the whole group (bash wrapper + pi child).
  const child = spawn("bash", [scriptPath], { stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  record.child = child;
  child.once("exit", (code) => {
    record.exitCode = code ?? 1;
  });
  child.once("error", (error) => {
    record.exitCode = 1;
    try {
      writeFileSync(record.logPath!, `Failed to launch background subagent: ${error.message}\n`, { flag: "a" });
    } catch {}
  });
}

/**
 * Tail the last `lines` lines of the surface's log file. Serves as the
 * background surface's "screen" for the sentinel scan and stall detection in
 * pollForExit; empty string when there is nothing to read yet.
 */
export function readBackground(surface: string, lines: number): string {
  const record = surfaces.get(surface);
  if (!record?.logPath || !existsSync(record.logPath)) return "";
  return readFileSync(record.logPath, "utf8").split("\n").slice(-Math.max(1, lines) - 1).join("\n");
}

/**
 * Send the headless subagent its graceful cancellation signal. Background
 * surfaces have no terminal input, so SIGINT stands in for Escape. The
 * signal goes to the WHOLE process group: the detached wrapper is a bash
 * script whose foreground child is the pi process, and signalling only the
 * bash would orphan pi. Returns false when there is no live child to signal.
 * The caller still closes the surface (SIGTERM) to guarantee termination.
 */
export async function interruptBackground(surface: string, gracePeriodMs = 500): Promise<boolean> {
  const record = surfaces.get(surface);
  const child = record?.child;
  if (!record || !child || record.exitCode !== null || child.exitCode !== null) return false;
  try {
    try {
      process.kill(-child.pid!, "SIGINT");
    } catch {
      // Group signalling can fail (e.g. EPERM); fall back to the bash
      // process itself so the signal is not silently dropped.
      child.kill("SIGINT");
    }
  } catch {
    return false;
  }
  if (record.exitCode !== null || child.exitCode !== null) return true;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, Math.max(0, gracePeriodMs));
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
  return true;
}

export function backgroundExitCode(surface: string): number | null | undefined {
  const record = surfaces.get(surface);
  return record?.exitCode ?? record?.child?.exitCode;
}
export function hasBackgroundSurface(surface: string): boolean {
  return surfaces.has(surface);
}
export function backgroundLogPath(surface: string): string | undefined {
  return surfaces.get(surface)?.logPath;
}
/**
 * Set (or replace) the record's log path. The log path is only knowable at
 * launch time (it is derived from the caller-provided script path under
 * `artifacts/<sessionId>/subagent-logs/`), so it is registered here.
 */
export function setBackgroundLogPath(surface: string, logPath: string): void {
  const record = surfaces.get(surface);
  if (!record) throw new Error(`Unknown background surface: ${surface}`);
  // `!= null` (not `!== null`): a record with no child yet has
  // child?.exitCode === undefined, which must NOT count as "exited".
  if (record.exitCode != null || record.child?.exitCode != null) {
    throw new Error(`Cannot set log path after the background child exited: ${surface}`);
  }
  mkdirSync(dirname(logPath), { recursive: true });
  record.logPath = logPath;
}

/**
 * Close a background surface: kill its process GROUP (bash wrapper + pi
 * child) with SIGTERM and await exit for up to 5s. Fail-closed: on timeout
 * the record is RETAINED in the registry (ownership must remain held so a
 * retry or the shutdown sweep can still reach the child); the error
 * propagates to the caller.
 *
 * The group SIGTERM is sent in BOTH paths: while the child is still running
 * (and we await its exit), and best-effort after the child has already
 * exited (the detached-group grandchild case — a `sleep N &` the script
 * spawned survives its parent's exit, but it is still in the same process
 * group, so the group signal reaches it). ESRCH is expected and harmless
 * when the whole group is already gone; the pid-reuse window between
 * "child exited" and "group signal" is seconds, which is accepted here
 * (signalling the group by the exited child's pid could in theory hit a
 * recycled pid — negligible against the hygiene win).
 */
export async function closeBackground(surface: string): Promise<void> {
  const record = surfaces.get(surface);
  const child = record?.child;
  if (child && record.exitCode === null && child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        reject(
          new Error(
            `Background process group did not exit after SIGTERM: ${surface}. Ownership must remain held.`,
          ),
        );
      }, 5000);
      // unref: this close also runs from session_shutdown teardown, where an
      // un-awaited remainder would otherwise keep the event loop alive for up
      // to 5s after everything else is done. Live waits are unaffected — the
      // caller's process is still running (other handles keep the loop up),
      // and a live wait either resolves on exit or rejects at 5s exactly as
      // before.
      timer.unref();
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
      try {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } catch (error) {
        clearTimeout(timer);
        child.off("exit", onExit);
        reject(error);
      }
    });
  }
  // Best-effort group kill now that the wrapper has exited (or never ran):
  // detached grandchildren (`sleep N &` style) outlive their parent and must
  // be taken down with the surface. ESRCH is expected when the group is
  // already gone; see the pid-reuse note in the doc comment above.
  if (child?.pid != null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // ESRCH (group already gone) or EPERM — nothing to do.
    }
  }
  surfaces.delete(surface);
}
export function allBackgroundSurfaces(): string[] {
  return [...surfaces.keys()];
}
