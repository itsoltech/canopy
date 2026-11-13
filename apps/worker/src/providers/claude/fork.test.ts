import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeTurn } from "./transcript.ts";
import { Effect, Layer, Schema } from "effect";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  RewindThreadSchema,
  ThreadSpecSchema,
  Provider,
} from "@canopy/contracts";
import { ClaudeThreads } from "./threads.ts";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { isString, jsonObject, jsonString } from "../json.ts";

/**
 * Fork from a turn (docs/claude-adapter.md, "Fork"): the turn's provider ref is the last entry Claude Code wrote
 * for it (readClaudeTurn / the live mapping), and forkSession up to that entry keeps the turns up to and
 * including it, nothing after. Runs the SDK's file operation on a three-turn session in the recorded transcript shape (no model).
 */
const home = mkdtempSync(join(tmpdir(), "canopy-claude-fork-"));
const cwd = "/repo/project";
const projectDir = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A session Claude Code writes turn by turn: `next(word)` appends one turn and returns the offset it starts at. */
function session() {
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
      {
        parentUuid: parent,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: `message ${word}` },
        uuid: user,
        sessionId,
        cwd,
        timestamp: at(0),
      },
      {
        parentUuid: user,
        isSidechain: false,
        type: "assistant",
        uuid: answer,
        sessionId,
        cwd,
        timestamp: at(500),
        message: {
          id: `msg_${word}`,
          role: "assistant",
          model: "claude-x",
          stop_reason: "end_turn",
          content: [{ type: "text", text: `answer ${word}` }],
        },
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
    const content = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.optionalKey(Schema.Json) }))(
      m.message,
    ).content;

    return isString(content)
      ? content
      : Array.isArray(content)
        ? content.map((b) => jsonString(jsonObject(b)?.["text"])).join("")
        : "";
  });

describe("Claude fork at a turn", () => {
  test("repeated in-place rewind uses the original session with its original UUIDs", async () => {
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = home;
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;

    try {
      const source = session();
      const first = await readClaudeTurn(home, source.sessionId, source.next("one"));
      const second = await readClaudeTurn(home, source.sessionId, source.next("two"));
      source.next("three");
      await Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* ClaudeThreads;

          const thread = create(ThreadSpecSchema, {
            threadId: Bun.randomUUIDv7(),
            provider: Provider.CLAUDE,
            providerThreadId: source.sessionId,
            cwd,
          });

          const replacement = yield* threads.rewind(
            create(RewindThreadSchema, {
              thread,
              sourceProviderThreadId: source.sessionId,
              afterProviderTurnRef: second!.end!.providerTurnRef ?? "",
            }),
          );

          thread.providerThreadId = replacement.providerThreadId ?? "";

          const repeated = yield* threads.rewind(
            create(RewindThreadSchema, {
              thread,
              sourceProviderThreadId: source.sessionId,
              afterProviderTurnRef: first!.end!.providerTurnRef ?? "",
            }),
          );

          const kept = yield* Effect.promise(() => getSessionMessages(repeated.providerThreadId ?? "", { dir: cwd }));
          const original = yield* Effect.promise(() => getSessionMessages(source.sessionId, { dir: cwd }));
          expect(texts(kept)).toEqual(["message one", "answer one"]);
          expect(texts(original)).toHaveLength(6);
        }).pipe(
          Effect.provide(
            ClaudeThreads.layer({
              home,
              baseEnv: {},
              nativeTools: { nativeSubagents: false, nativeScheduling: false },
              profile: () => profile,
              publish: () => {},
              interact: async () => create(InteractionResponseSchema),
              callTool: async () => create(AgentToolResultSchema),
            }).pipe(Layer.provideMerge(Journal.layer(join(home, "journal.db")))),
          ),
          Effect.scoped,
        ),
      );
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });
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
      expect(texts(await getSessionMessages(forked.sessionId, { dir: cwd }))).toEqual([
        "message one",
        "answer one",
        "message two",
        "answer two",
      ]);
      // The source is untouched.
      expect(texts(await getSessionMessages(sessionId, { dir: cwd }))).toHaveLength(6);
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });
});
