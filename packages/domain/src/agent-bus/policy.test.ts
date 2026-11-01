import { describe, expect, test } from "bun:test";
import { authorizeBusCall, DEFAULT_BUS_LIMITS, type BusFacts, type ThreadNode } from "./policy.ts";
import type { AgentBusCall } from "./tools.ts";

// Tree: root (level 0) -> a, b (level 1). Another tree: x.
const node = (id: string, ancestorIds: string[], provider = "claude", rootId = "root"): ThreadNode => ({
  id,
  rootId,
  depth: ancestorIds.length,
  ancestorIds,
  provider,
  archived: false,
});
const root = node("root", []);
const a = node("a", ["root"]);
const b = node("b", ["root"], "codex");
const x = node("x", [], "claude", "x");
const all = new Map([root, a, b, x].map((n) => [n.id, n]));
const NOW = new Date("2026-11-01T12:00:00Z");

const facts = (caller: ThreadNode, extra: Partial<BusFacts> = {}): BusFacts => ({
  caller,
  callerHops: 0,
  targets: all,
  callerChildren: 0,
  activeInTree: 1,
  now: NOW,
  ...extra,
});
const reason = (call: AgentBusCall, f: BusFacts) => {
  const d = authorizeBusCall(call, f);
  return d.allowed ? "allowed" : d.reason;
};

describe("two levels: main thread orchestrates, side threads work", () => {
  test("only the main thread can spawn; side threads are told to ask their parent", () => {
    const spawn: AgentBusCall = { tool: "spawn_thread", args: { title: "t", prompt: "p" } };
    expect(authorizeBusCall(spawn, facts(root))).toEqual({ allowed: true, hops: 1 });
    expect(reason(spawn, facts(a))).toContain("not available in side threads");
  });

  test("side threads cannot interrupt, close or answer for others", () => {
    expect(reason({ tool: "interrupt_thread", args: { thread_id: "b" } }, facts(a))).toContain("not available in side threads");
    expect(reason({ tool: "list_interactions", args: {} }, facts(a))).toContain("not available in side threads");
  });

  test("main thread controls its side threads", () => {
    expect(reason({ tool: "interrupt_thread", args: { thread_id: "a" } }, facts(root))).toBe("allowed");
    expect(reason({ tool: "close_thread", args: { thread_id: "b" } }, facts(root))).toBe("allowed");
    expect(reason({ tool: "close_thread", args: { thread_id: "x" } }, facts(root))).toContain("not found");
  });

  test("spawn limits and fork provider", () => {
    const spawn = (fork?: boolean): AgentBusCall => ({
      tool: "spawn_thread",
      args: fork === undefined ? { title: "t", prompt: "p" } : { title: "t", prompt: "p", fork },
    });
    expect(reason(spawn(), facts(root, { callerChildren: DEFAULT_BUS_LIMITS.maxChildrenPerThread }))).toContain("side thread limit");
    expect(reason(spawn(), facts(root, { activeInTree: DEFAULT_BUS_LIMITS.maxActiveThreadsPerTree }))).toContain("too many active");
    expect(reason(spawn(true), facts(root, { spawnProvider: "codex" }))).toContain("fork keeps the provider");
    expect(reason(spawn(false), facts(root, { spawnProvider: "codex" }))).toBe("allowed");
  });
});

describe("communication inside the tree", () => {
  const send = (to: string): AgentBusCall => ({ tool: "send_message", args: { thread_id: to, prompt: "hi" } });

  test("parent, children and siblings are reachable; other trees and self are not", () => {
    expect(reason(send("a"), facts(root))).toBe("allowed"); // child
    expect(reason(send("root"), facts(a))).toBe("allowed"); // parent
    expect(reason(send("b"), facts(a))).toBe("allowed"); // sibling
    expect(reason(send("x"), facts(a))).toContain("not found in your thread tree");
    expect(reason(send("a"), facts(a))).toContain("itself");
    expect(reason({ tool: "wait_threads", args: { thread_ids: ["a", "x"] } }, facts(root))).toContain("not found");
    expect(reason({ tool: "read_thread", args: { thread_id: "b" } }, facts(a))).toBe("allowed");
  });

  test("hops stop agent ping-pong without human input", () => {
    const limit = DEFAULT_BUS_LIMITS.maxHops;
    const quiet: AgentBusCall = { tool: "send_message", args: { thread_id: "b", prompt: "again", notify: false } };
    expect(authorizeBusCall(quiet, facts(a, { callerHops: limit - 1 }))).toEqual({ allowed: true, hops: limit });
    expect(reason(quiet, facts(a, { callerHops: limit }))).toContain("chain limit");
    // With notify, the reply turn back to the caller needs one more hop.
    expect(reason(send("b"), facts(a, { callerHops: limit - 1 }))).toContain("chain limit");
  });

  test("archived threads cannot be messaged", () => {
    const archived = new Map(all).set("b", { ...b, archived: true });
    expect(reason(send("b"), facts(a, { targets: archived }))).toContain("archived");
  });
});

describe("interactions routed to the parent", () => {
  const answer = (response: "allow" | "deny" | "answer" | "cancel", answer_json?: string): AgentBusCall => ({
    tool: "answer_interaction",
    args: answer_json === undefined ? { request_id: "i1", response } : { request_id: "i1", response, answer_json },
  });
  const permission = { id: "i1", threadId: "a", kind: "permission", routedTo: "parent", status: "pending" } as const;

  test("the parent answers pending prompts of its side threads", () => {
    expect(reason(answer("allow"), facts(root, { interaction: permission }))).toBe("allowed");
    expect(reason(answer("deny"), facts(root, { interaction: permission }))).toBe("allowed");
  });

  test("not when routed to the user, already answered, or from another tree", () => {
    expect(reason(answer("allow"), facts(root, { interaction: { ...permission, routedTo: "human" } }))).toContain("by the user");
    expect(reason(answer("allow"), facts(root, { interaction: { ...permission, status: "allowed" } }))).toContain("already");
    expect(reason(answer("allow"), facts(root, { interaction: { ...permission, threadId: "x" } }))).toContain("not found");
    expect(reason(answer("allow"), facts(root))).toContain("not found");
  });

  test("response must fit the kind", () => {
    expect(reason(answer("answer", "{}"), facts(root, { interaction: permission }))).toContain("allow or deny");
    const question = { ...permission, kind: "question" } as const;
    expect(reason(answer("allow"), facts(root, { interaction: question }))).toContain("answer or cancel");
    expect(reason(answer("answer"), facts(root, { interaction: question }))).toContain("answer_json");
    expect(reason(answer("answer", '{"choice":"staging"}'), facts(root, { interaction: question }))).toBe("allowed");
  });
});

describe("schedules", () => {
  const wakeup = (args: Partial<Extract<AgentBusCall, { tool: "schedule_wakeup" }>["args"]>): AgentBusCall => ({
    tool: "schedule_wakeup",
    args: { prompt: "check CI", ...args },
  });
  const recurring = (args: Partial<Extract<AgentBusCall, { tool: "schedule_recurring" }>["args"]>): AgentBusCall => ({
    tool: "schedule_recurring",
    args: { prompt: "report", cron: "*/30 * * * *", max_runs: 10, ...args },
  });

  test("wake-up: own thread or a side thread of mine, exactly one time spec, within 7 days", () => {
    expect(authorizeBusCall(wakeup({ delay_seconds: 600 }), facts(a))).toEqual({ allowed: true, hops: 1 });
    expect(reason(wakeup({ delay_seconds: 600, thread_id: "a" }), facts(root))).toBe("allowed");
    expect(reason(wakeup({ delay_seconds: 600, thread_id: "b" }), facts(a))).toContain("only control threads you spawned");
    expect(reason(wakeup({}), facts(a))).toContain("exactly one");
    expect(reason(wakeup({ delay_seconds: 600, at: "2026-11-01T13:00:00Z" }), facts(a))).toContain("exactly one");
    expect(reason(wakeup({ at: "2026-11-01T13:00:00Z" }), facts(a))).toBe("allowed");
    expect(reason(wakeup({ at: "2026-11-20T13:00:00Z" }), facts(a))).toContain("7 days");
    expect(reason(wakeup({ at: "tomorrow" }), facts(a))).toContain("ISO 8601");
  });

  test("recurring: bounded, valid cron, minimum interval, known time zone", () => {
    expect(reason(recurring({}), facts(root))).toBe("allowed");
    expect(reason({ tool: "schedule_recurring", args: { prompt: "p", cron: "0 9 * * 1-5" } }, facts(root))).toContain("until or max_runs");
    expect(reason(recurring({ cron: "* * * * *" }), facts(root))).toContain("every minute");
    expect(reason(recurring({ cron: "*/2 * * * *" }), facts(root))).toContain("below 5 minutes");
    expect(reason(recurring({ cron: "0 9 * *" }), facts(root))).toContain("five fields");
    expect(reason(recurring({ timezone: "Mars/Olympus" }), facts(root))).toContain("unknown time zone");
    expect(reason(recurring({ timezone: "Europe/Warsaw" }), facts(root))).toBe("allowed");
    expect(reason(recurring({ max_runs: undefined, until: "2027-06-01T00:00:00Z" } as never), facts(root))).toContain("within 30 days");
  });

  test("per-thread schedule limit and hops", () => {
    expect(reason(wakeup({ delay_seconds: 600 }), facts(a, { targetSchedules: DEFAULT_BUS_LIMITS.maxSchedulesPerThread }))).toContain(
      "schedule limit",
    );
    expect(reason(wakeup({ delay_seconds: 600 }), facts(a, { callerHops: DEFAULT_BUS_LIMITS.maxHops }))).toContain("chain limit");
  });

  test("cancel: own schedules and those of my side threads", () => {
    const cancel: AgentBusCall = { tool: "cancel_schedule", args: { schedule_id: "s1" } };
    expect(reason(cancel, facts(a, { schedule: { id: "s1", threadId: "a" } }))).toBe("allowed");
    expect(reason(cancel, facts(root, { schedule: { id: "s1", threadId: "a" } }))).toBe("allowed");
    expect(reason(cancel, facts(a, { schedule: { id: "s1", threadId: "b" } }))).toContain("not found");
  });
});
