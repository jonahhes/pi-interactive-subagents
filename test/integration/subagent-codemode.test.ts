/**
 * Integration tests for S4 (codemode in subagents), both backends (herdr or
 * tmux, auto-detected):
 *
 *   (1) GUARD-RUN — a parent spawns a `test-codemode` child (read-only tools
 *                    + codemode + bash-guard-mode: read-only). The child's
 *                    codemode script (a) `await tools.read` on a small file
 *                    and (b) `await tools.bash` with a write redirect. The
 *                    child's session jsonl must show: a codemode toolCall, a
 *                    nested read (status ok) AND a nested bash whose recorded
 *                    error is the read-only guard's refusal
 *                    (`[bash-guard read-only] … not allowed in read-only
 *                    mode`), and the tamper file must NOT exist on disk.
 *                    (Codemode's nested calls go through the same extension
 *                    tool pipeline, so bash-guard gates them.)
 *
 *   (2) RESUME REPLAY — after the child auto-exits, the parent
 *                    subagent_message-resumes the SAME child with a trivial
 *                    codemode task. The resumed run's codemode result (in the
 *                    SAME session jsonl — `pi --session <file>` appends)
 *                    must be a WORKING call, proving the extension set was
 *                    rebuilt from the loadout (the allowlist carries codemode;
 *                    no new loadout field is needed).
 *
 * All assertions read session .jsonl files and disk state — no screen
 * scraping, apart from the single "parent finished its turn" gate the other
 * suites use.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForParentSessionFile,
  parseSessionEntries,
  sleep,
  uniqueId,
  trackTempFile,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No multiplexer available — skipping subagent codemode integration tests");
  console.log("   Run inside tmux or herdr to enable these tests.");
}

/** All `codemode` toolResult entries in a child session file. */
function codemodeResults(sessionFile: string): any[] {
  return parseSessionEntries(sessionFile).filter(
    (e) =>
      e.type === "message" &&
      e.message?.role === "toolResult" &&
      e.message?.toolName === "codemode",
  );
}

/** The text output of one codemode result entry. */
function resultText(result: any): string {
  return (result?.message?.content ?? [])
    .map((c: any) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

/** The recorded nested calls of one codemode result (details.calls). */
function nestedCallsOf(result: any): any[] {
  return (result?.message?.details?.calls ?? []) as any[];
}

/** Poll a session file until a codemode toolResult whose output contains `tag` appears. */
async function waitForCodemodeResult(sessionFile: string, tag: string, timeout: number): Promise<any> {
  const start = Date.now();
  for (;;) {
    const match = codemodeResults(sessionFile).find((r) => resultText(r).includes(tag));
    if (match) return match;
    if (Date.now() - start > timeout) {
      const results = codemodeResults(sessionFile);
      throw new Error(
        `Timeout (${timeout}ms) waiting for a codemode result containing ${JSON.stringify(tag)}. ` +
          `Found ${results.length} codemode result(s): ${results
            .map((r) => JSON.stringify(resultText(r).slice(0, 200)))
            .join(" | ")}`,
      );
    }
    await sleep(1000);
  }
}

for (const backend of backends) {
  describe(`subagent-codemode [${backend}]`, { timeout: PI_TIMEOUT * 6 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("a codemode child's nested bash is refused by the read-only guard, and resume replays codemode", async () => {
      const id = uniqueId();
      const childName = `Cm-${id}`;
      const tamperFile = `/tmp/pi-integ-codemode-guard-${id}.txt`;
      trackTempFile(env, tamperFile);

      // The file the child's codemode script reads (its first line is the marker).
      const smallFile = join(env.dir, "small.txt");
      writeFileSync(smallFile, `FIRST_${id}\nsecond line\n`, "utf8");

      const script1 = [
        `const r = await tools.read({ path: ${JSON.stringify(smallFile)} });`,
        `let out = 'READ:' + String(r).split('\\n')[0];`,
        `try { const b = await tools.bash({ command: ${JSON.stringify(`echo tamper > ${tamperFile}`)} }); out += ' BASHOK:' + JSON.stringify(b); }`,
        `catch (e) { out += ' BASHERR:' + String(e); }`,
        `return out;`,
      ].join("\n");
      const script2 = `return 'RUN2_${id}';`;

      const surface = await createTrackedSurface(env, `codemode-${id}`);
      await sleep(1000);

      // One parent run does both steps: spawn the child, and — once the
      // child's result steer arrives (the child has auto-exited) — resume the
      // SAME child with the trivial codemode task. Both steers must arrive
      // before the parent says CMOD_TEST_DONE.
      const task = [
        `You must do exactly these steps, in order:`,
        ``,
        `1. Call the subagent tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        `   agent: "test-codemode"`,
        `   task: "Call the codemode tool ONCE with EXACTLY this code argument - pass it through verbatim, do not modify or fence it:`,
        script1,
        `Then in your final message report VERBATIM the text the codemode tool returned (it starts with 'READ:'). Do not call any other tool."`,
        ``,
        `2. When the subagent result arrives, call the subagent_message tool with these EXACT parameters:`,
        `   name: "${childName}"`,
        `   message: "Call the codemode tool ONCE with EXACTLY this code argument - pass it through verbatim, do not modify or fence it:`,
        `${script2}`,
        `Then reply with the single word RESUMED. Do not call any other tool."`,
        ``,
        `3. When the resumed subagent result arrives, say CMOD_TEST_DONE and stop.`,
        `Do not call any other tools, and do not poll or check files.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The child's completion steer (in the parent's session file) carries
      // the child's session file; the codemode results are then read straight
      // from that jsonl (no screen scraping).
      const parentFile = await waitForParentSessionFile(childName);
      let childSessionFile: string | undefined;
      const deadline = Date.now() + PI_TIMEOUT * 4;
      while (!childSessionFile && Date.now() < deadline) {
        const results = parseSessionEntries(parentFile).filter(
          (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
        );
        const completion = results.find((e) => /completed/i.test(e.content));
        if (completion?.details?.sessionFile && existsSync(completion.details.sessionFile)) {
          childSessionFile = completion.details.sessionFile;
        } else {
          await sleep(1000);
        }
      }
      assert.ok(childSessionFile, "the child's completion steer carries its session file");
      assert.ok(existsSync(childSessionFile!), "the child's session jsonl exists");

      // ── (1) GUARD-RUN assertions on the child's session jsonl ──
      const result = await waitForCodemodeResult(childSessionFile!, `READ:FIRST_${id}`, PI_TIMEOUT * 3);
      assert.ok(!result.message.isError, "the codemode script itself succeeded (it caught the nested rejection)");
      const text = resultText(result);
      assert.ok(text.includes(`READ:FIRST_${id}`), `script output carries the read first line, got: ${text.slice(0, 300)}`);
      // The recorded script carried the tamper command (a reworded script
      // would not have tripped the guard on that path).
      assert.ok(
        JSON.stringify(result).includes(tamperFile),
        `the recorded nested call carried the tamper command, got: ${JSON.stringify(result).slice(0, 400)}`,
      );

      const calls = nestedCallsOf(result);
      const readCall = calls.find((c) => c.name === "read");
      assert.ok(readCall, "the nested tools.read call is recorded");
      assert.equal(readCall.status, "ok", "the nested read succeeded");
      const bashCall = calls.find((c) => c.name === "bash");
      assert.ok(bashCall, "the nested tools.bash call is recorded");
      assert.equal(bashCall.status, "error", "the nested bash was REFUSED, not executed");
      // The refusal is the READ-ONLY guard's (the child runs
      // bash-guard-mode: read-only): it names the rule and the read-only mode.
      assert.match(bashCall.error, /\[bash-guard read-only\]/, `expected the read-only guard's refusal, got: ${bashCall.error}`);
      assert.match(bashCall.error, /not allowed in read-only mode/, `expected 'not allowed in read-only mode', got: ${bashCall.error}`);
      assert.match(bashCall.error, new RegExp(tamperFile.replace(/\//g, "\\/")), "the refusal names the tamper target");
      // And the script saw the same text (it printed BASHERR with it).
      assert.ok(
        text.includes("[bash-guard read-only]") && text.includes("not allowed in read-only mode"),
        `the script output carries the guard refusal text, got: ${text.slice(0, 400)}`,
      );

      // The guard actually blocked it: the write never happened.
      await sleep(5000);
      assert.equal(existsSync(tamperFile), false, `the read-only guard must prevent the write; ${tamperFile} must not exist`);

      // ── (2) RESUME REPLAY assertions ──
      // The resumed run's codemode result (RUN2_<id>) lands in the SAME
      // session file (pi --session <file> appends), and the resume steer's
      // sessionFile is the same file — the extension set was rebuilt from
      // the loadout, not lost.
      const resumeResult = await waitForCodemodeResult(childSessionFile!, `RUN2_${id}`, PI_TIMEOUT * 4);
      assert.ok(!resumeResult.message.isError, "the resumed run's codemode call succeeded");
      const resumeText = resultText(resumeResult);
      assert.ok(resumeText.includes(`RUN2_${id}`), `resumed codemode output, got: ${resumeText.slice(0, 300)}`);

      // Both runs' codemode results coexist in the one session jsonl.
      assert.ok(
        codemodeResults(childSessionFile!).length >= 2,
        "the session jsonl holds the original AND the resumed codemode results",
      );
      // The parent saw BOTH completions (the resumed run's steer lands in the
      // parent's jsonl a little AFTER the child's resumed codemode result,
      // so poll rather than doing a single read). Both steers must point at
      // the same (resumed) session file.
      let resumeSteer: any[] = [];
      const steerDeadline = Date.now() + PI_TIMEOUT * 3;
      while (Date.now() < steerDeadline) {
        const allResults = parseSessionEntries(parentFile).filter(
          (e) => e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === childName,
        );
        resumeSteer = allResults.filter((e) => /completed/i.test(e.content));
        if (resumeSteer.length >= 2) break;
        await sleep(1000);
      }
      assert.ok(resumeSteer.length >= 2, "both the original and the resumed completion steers arrived");
      assert.ok(
        resumeSteer.every((e) => e.details?.sessionFile === childSessionFile),
        "every completion steer points at the same (resumed) session file",
      );

      // The parent finished both turns.
      await waitForScreen(surface, /CMOD_TEST_DONE/, PI_TIMEOUT * 2);
    });
  });
}
