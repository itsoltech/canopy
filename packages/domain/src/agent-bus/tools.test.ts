import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { JsonObject } from "../json.ts";
import { AGENT_BUS_TOOLS, agentBusToolSpecs, agentBusToolsFor, decodeAgentBusCall } from "./tools.ts";

const THREAD = "0196f0c1-0000-7000-8000-000000000000";

function failure(name: string, args: JsonObject): string {
  return failureOf(name, JSON.stringify(args));
}

function failureOf(name: string, argumentsJson: string): string {
  const result = decodeAgentBusCall(name, argumentsJson);

  if (Result.isSuccess(result)) throw new Error(`expected failure for ${name}`);

  return result.failure;
}

describe("agent bus tool specs", () => {
  const specs = agentBusToolSpecs();

  test("one spec per model-facing tool, every input is a closed object schema", () => {
    expect(specs.map((s) => s.name).sort()).toEqual(
      Object.keys(AGENT_BUS_TOOLS)
        .filter((name) => name !== "import_image_reply")
        .sort(),
    );

    for (const spec of specs) {
      expect(spec.inputSchema["type"]).toBe("object");
      expect(spec.inputSchema["additionalProperties"]).toBe(false);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  test("constraints reach the provider schema", () => {
    const wait = specs.find((s) => s.name === "wait_threads")!.inputSchema as {
      properties: Record<string, JsonObject>;
      required: string[];
    };

    expect(wait.required).toEqual(["thread_ids"]);
    expect(wait.properties["thread_ids"]).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    expect(wait.properties["timeout_seconds"]).toMatchObject({ type: "integer", minimum: 1, maximum: 300 });
    expect(wait.properties["until"]).toMatchObject({ enum: ["any", "all"] });
    const spawn = specs.find((s) => s.name === "spawn_thread")!.inputSchema;
    expect(spawn["properties"]).not.toHaveProperty("permission_mode");
  });
});

describe("tool sets per level", () => {
  test("main thread gets everything; side threads cannot spawn, control or answer for others", () => {
    expect([...agentBusToolsFor(0)].sort() as string[]).toEqual(Object.keys(AGENT_BUS_TOOLS).sort());
    expect(agentBusToolsFor(1).sort()).toEqual([
      "ask_user",
      "cancel_schedule",
      "get_answers",
      "get_background_task",
      "get_thread",
      "import_image_reply",
      "list_agents",
      "list_background_tasks",
      "list_schedules",
      "list_threads",
      "read_thread",
      "request_secret",
      "schedule_recurring",
      "schedule_wakeup",
      "send_message",
      "show_images",
      "stop_background_task",
      "wait_threads",
    ]);
    expect(agentBusToolSpecs(agentBusToolsFor(1)).map((s) => s.name)).not.toContain("spawn_thread");
    expect(agentBusToolSpecs().map((s) => s.name)).not.toContain("import_image_reply");
  });
});

describe("decodeAgentBusCall", () => {
  test("valid calls decode to typed arguments", () => {
    const spawn = decodeAgentBusCall(
      "spawn_thread",
      JSON.stringify({ title: "Review", prompt: "Review the diff", fork: true }),
    );

    expect(Result.isSuccess(spawn) && spawn.success).toEqual({
      tool: "spawn_thread",
      args: { title: "Review", prompt: "Review the diff", fork: true },
    });
    const list = decodeAgentBusCall("list_agents", "");
    expect(Result.isSuccess(list) && list.success).toEqual({ tool: "list_agents", args: {} });
  });

  test("rejects unknown tools, invalid JSON, unknown properties and out-of-range values", () => {
    expect(failure("spawn_agent", {})).toContain("unknown agent bus tool");
    expect(failureOf("get_thread", "{oops")).toContain("not valid JSON");
    expect(failure("get_thread", { thread_id: THREAD, extra: 1 })).toContain("excess property");
    expect(failure("get_thread", { thread_id: "not-a-uuid" })).toContain("thread_id");
    expect(failure("wait_threads", { thread_ids: [THREAD], timeout_seconds: 999 })).toContain("timeout_seconds");
    expect(failure("wait_threads", { thread_ids: [] })).toContain("thread_ids");
    expect(failure("send_message", { thread_id: THREAD, prompt: "x", delivery: "now" })).toContain("delivery");
    expect(failure("spawn_thread", { title: "", prompt: "x" })).toContain("title");
    expect(failure("spawn_thread", { title: "t", prompt: "x", interactions: "robot" })).toContain("interactions");
    expect(failure("answer_interaction", { request_id: THREAD, response: "maybe" })).toContain("response");
    expect(failure("schedule_wakeup", { prompt: "x", delay_seconds: 10 })).toContain("delay_seconds");
  });
});
