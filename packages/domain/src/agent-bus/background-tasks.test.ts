import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { authorizeBusCall, type BusFacts, type ThreadNode } from "./policy.ts";
import { agentBusToolsFor, decodeAgentBusCall, type AgentBusCall } from "./tools.ts";

const node = (id: string, ancestorIds: string[], extra: Partial<ThreadNode> = {}): ThreadNode => ({
  id,
  rootId: "00000000-0000-7000-8000-00000000000r",
  depth: ancestorIds.length,
  ancestorIds,
  provider: "codex",
  ownerId: "owner",
  archived: false,
  ...extra,
});

const ROOT = "0196f0c1-0000-7000-8000-000000000000";
const CHILD = "0196f0c1-0000-7000-8000-000000000001";
const SIBLING = "0196f0c1-0000-7000-8000-000000000002";
const FOREIGN = "0196f0c1-0000-7000-8000-000000000003";
const root = node(ROOT, []);
const child = node(CHILD, [ROOT]);
const sibling = node(SIBLING, [ROOT]);
const foreign = { ...node(FOREIGN, []), rootId: "other" };
const stranger = { ...node(FOREIGN, []), rootId: "other", ownerId: "someone-else" };

const facts = (caller: ThreadNode, targets: ThreadNode[] = [root, child, sibling, foreign]): BusFacts => ({
  caller,
  callerHops: 7,
  targets: new Map(targets.map((t) => [t.id, t])),
  callerChildren: 0,
  activeInTree: 1,
  now: new Date(),
});

const decision = (call: AgentBusCall, f: BusFacts) => {
  const d = authorizeBusCall(call, f);

  return d.allowed ? "allowed" : d.reason;
};

describe("background task tools", () => {
  test("every thread has them, side threads too", () => {
    for (const depth of [0, 1])
      expect(agentBusToolsFor(depth)).toEqual(
        expect.arrayContaining(["list_background_tasks", "get_background_task", "stop_background_task"]),
      );
  });

  test("calls decode strictly", () => {
    const get = decodeAgentBusCall("get_background_task", JSON.stringify({ task_id: "bg:exec-1", output_lines: 20 }));
    expect(Result.isSuccess(get) && get.success).toEqual({
      tool: "get_background_task",
      args: { task_id: "bg:exec-1", output_lines: 20 },
    });
    expect(
      Result.isFailure(decodeAgentBusCall("get_background_task", JSON.stringify({ task_id: "x", output_lines: 9999 }))),
    ).toBe(true);
    expect(Result.isFailure(decodeAgentBusCall("list_background_tasks", JSON.stringify({ status: "lost" })))).toBe(
      true,
    );
    expect(Result.isFailure(decodeAgentBusCall("stop_background_task", JSON.stringify({})))).toBe(true);
  });

  test("own tasks: always, without hops (no turn starts)", () => {
    expect(authorizeBusCall({ tool: "list_background_tasks", args: {} }, facts(child))).toEqual({ allowed: true });
    expect(decision({ tool: "stop_background_task", args: { task_id: "4242" } }, facts(child))).toBe("allowed");
    expect(decision({ tool: "get_background_task", args: { task_id: "4242", thread_id: CHILD } }, facts(child))).toBe(
      "allowed",
    );
  });

  test("another thread: read any of the owner's; stop only a descendant's", () => {
    expect(decision({ tool: "get_background_task", args: { task_id: "1", thread_id: SIBLING } }, facts(child))).toBe(
      "allowed",
    );
    // Reads reach any thread of the same owner (like get_thread); other owners' threads look missing.
    expect(decision({ tool: "list_background_tasks", args: { thread_id: FOREIGN } }, facts(child))).toBe("allowed");
    expect(
      decision({ tool: "list_background_tasks", args: { thread_id: FOREIGN } }, facts(child, [stranger])),
    ).toContain("not found");
    expect(decision({ tool: "stop_background_task", args: { task_id: "1", thread_id: CHILD } }, facts(root))).toBe(
      "allowed",
    );
    expect(
      decision({ tool: "stop_background_task", args: { task_id: "1", thread_id: SIBLING } }, facts(child)),
    ).toContain("only control threads you spawned");
  });
});
