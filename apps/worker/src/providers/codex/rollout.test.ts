import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { RolloutTail } from "./rollout.ts";

const dir = tempDir("canopy-rollout-");

const line = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-11-01T20:00:00.000Z", type, payload }) + "\n";

describe("RolloutTail", () => {
  test("starts at the end, returns complete lines only, turn boundaries and response items", () => {
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, line("response_item", { type: "message", role: "user", content: [] })); // history: skipped
    const tail = new RolloutTail(path);
    expect(tail.read()).toEqual([]);

    const call = line("response_item", { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text('x')" });
    appendFileSync(path, line("turn_context", { turn_id: "t1", cwd: "/work/repo" }) + call.slice(0, 20));
    expect(tail.read()).toEqual([{ kind: "turn", turnId: "t1", ended: false }]);
    appendFileSync(path, call.slice(20) + line("event_msg", { type: "token_count" }) + line("event_msg", { type: "task_complete", turn_id: "t1" }));
    expect(tail.read()).toEqual([
      { kind: "item", item: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text('x')" } },
      { kind: "turn", turnId: "t1", ended: true },
    ]);
  });

  test("a file Codex has not created yet is read from its start", () => {
    const path = join(dir, "later.jsonl");
    const tail = new RolloutTail(path);
    expect(tail.read()).toEqual([]);
    writeFileSync(path, line("event_msg", { type: "task_started", turn_id: "t2" }));
    expect(tail.read()).toEqual([{ kind: "turn", turnId: "t2", ended: false }]);
  });
});
