import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeTurn } from "./transcript.ts";

/**
 * Fork from a turn (docs/claude-adapter.md, "Fork"): the turn's provider ref is the last entry Claude Code wrote
 * for it (readClaudeTurn / the live mapping), and forkSession up to that entry keeps the turns up to and
 * including it, nothing after. Runs the SDK's file operation on a three-turn session in the recorded transcript shape (no model).
 */
const home = mkdtempSync(join(tmpdir(), "oa-claude-fork-"));
const cwd = "/repo/project";
const projectDir = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A session Claude Code writes turn by turn: `next(word)` appends one turn and returns the offset it starts at. */
function session(): { sessionId: string; next: (word: string) => number } {
  const sessionId = crypto.randomUUID();
  const lines: string[] = [];
  let bytes = 0;
  let parent: string | null = null;
  let i = 0;
  const start = Date.parse("2026-11-02T10:00:00Z");
  mkdirSync(projectDir, { recursive: true });
  const next = (word: string) => {
    const offset = bytes;
    const user = crypto.randomUUID();
    const answer = crypto.randomUUID();
    const at = (ms: number) => new Date(start + i * 10_000 + ms).toISOString();
    for (const entry of [
      { parentUuid: parent, isSidechain: false, type: "user", message: { role: "user", content: `message ${word}` }, uuid: user, sessionId, cwd, timestamp: at(0) },
      {
        parentUuid: user, isSidechain: false, type: "assistant", uuid: answer, sessionId, cwd, timestamp: at(500),
        message: { id: `msg_${word}`, role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text: `answer ${word}` }] },
      },
    ]) {
      const line = `${JSON.stringify(entry)}\n`;
      lines.push(line);
      bytes += Buffer.byteLength(line);
    }
    parent = answer;
    i++;
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join(""));
    return offset;
  };
  return { sessionId, next };
}

const texts = (messages: Awaited<ReturnType<typeof getSessionMessages>>) =>
  messages.map((m) => {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("") : "";
  });

describe("Claude fork at a turn", () => {
  test("forkSession up to the turn's ref keeps turns 1–2 and drops turn 3", async () => {
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = home;
    try {
      const { sessionId, next } = session();
      next("one");
      // The ref of turn 2: what the worker reports as provider_turn_ref when the turn ends.
      const second = await readClaudeTurn(home, sessionId, next("two"));
      const ref = second?.end?.providerTurnRef ?? "";
      expect(ref).not.toBe("");
      next("three");

      const forked = await forkSession(sessionId, { dir: cwd, upToMessageId: ref });
      expect(forked.sessionId).not.toBe(sessionId);
      expect(texts(await getSessionMessages(forked.sessionId, { dir: cwd }))).toEqual(["message one", "answer one", "message two", "answer two"]);
      // The source is untouched.
      expect(texts(await getSessionMessages(sessionId, { dir: cwd }))).toHaveLength(6);
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });
});
