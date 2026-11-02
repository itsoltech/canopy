import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { isWorking, workState } from "./activity.ts";

const thread = (extra: { status?: string; backgroundTasks?: number; pendingInteractions?: number; interactionRoute?: string }) =>
  create(ui.ThreadSchema, { id: "t", status: "idle", ...extra });

describe("workState", () => {
  test("a person's wait comes before a running turn and background tasks", () => {
    expect(workState(thread({ status: "running", pendingInteractions: 1, backgroundTasks: 2 }))).toBe("needs");
    expect(workState(thread({ status: "waiting_input" }))).toBe("needs");
    expect(workState(thread({ status: "running", pendingInteractions: 1, interactionRoute: "parent" }))).toBe("asks");
  });

  test("a turn running or starting, then background tasks alone", () => {
    expect(workState(thread({ status: "running", backgroundTasks: 1 }))).toBe("running");
    expect(workState(thread({ status: "creating" }))).toBe("starting");
    expect(workState(thread({ status: "idle", backgroundTasks: 1 }))).toBe("background");
    expect(workState(thread({ status: "failed", backgroundTasks: 1 }))).toBe("background");
  });

  test("idle, failed and interrupted threads without tasks rest", () => {
    for (const status of ["idle", "failed", "interrupted"]) expect(workState(thread({ status }))).toBe("idle");
    expect(isWorking(thread({ status: "idle" }))).toBe(false);
    expect(isWorking(thread({ status: "idle", backgroundTasks: 1 }))).toBe(true);
    expect(isWorking(thread({ status: "running", pendingInteractions: 1 }))).toBe(false);
  });
});
