import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { plannedUpdateRun } from "./update-plan.ts";
import {
  furthestStatus,
  restartDetail,
  RESTART_WARNING_MS,
  runStatuses,
  updateRunSummary,
  updateTargetKey,
  UPDATED_FRESH_MS,
} from "./update-status.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");

/** This computer with a downloaded app, a binary worker behind its gateway, an outdated CLI and a linked computer. */
function fleet() {
  return create(ui.UpdatesSnapshotSchema, {
    gatewayVersion: "2.0.0",
    gatewayBundled: true,
    appUpdateSupported: true,
    computerName: "Desk",
    app: { connected: true, version: "1.0.0", ready: true, updaterVersion: "2.0.0" },
    workers: [
      { workerId: "w1", name: "ci-runner", version: "1.0.0", installKind: "binary", connected: true },
      { workerId: "w2", name: "Brew worker", version: "1.0.0", installKind: "homebrew", connected: true },
    ],
    cliWorkers: [
      {
        id: "w1",
        name: "ci-runner",
        cliTools: [
          {
            tool: { provider: Provider.CLAUDE, version: "1.0.0", installable: true },
            latest: { version: "1.1.0" },
            updateAvailable: true,
            action: "update",
          },
        ],
      },
    ],
    computers: [
      {
        nodeId: "studio",
        name: "Studio",
        presence: "connected",
        remoteUpdate: true,
        updates: { gatewayVersion: "2.0.0", app: { connected: true, version: "1.0.0", availableVersion: "2.0.0" } },
      },
    ],
  });
}

describe("shared Update all planner", () => {
  test("clients predict the gateway's steps: same targets, skipped items apart, this computer last", () => {
    const run = plannedUpdateRun(fleet(), "pending");

    expect(run.state).toBe("running");
    expect(run.steps.map((step) => [step.kind, step.state])).toEqual([
      ["worker", "queued"],
      ["worker", "skipped"],
      ["cli", "queued"],
      ["computer", "queued"],
      ["app", "queued"],
    ]);

    // The keys rows compute for themselves find the predicted steps.
    const statuses = runStatuses(run, NOW);
    expect(statuses.get(updateTargetKey({ kind: "worker", workerId: "w1" }))).toBe("queued");
    expect(statuses.get(updateTargetKey({ kind: "cli", workerId: "w1", provider: Provider.CLAUDE }))).toBe("queued");
    expect(statuses.get(updateTargetKey({ kind: "computer", nodeId: "studio" }))).toBe("queued");
    expect(statuses.get(updateTargetKey({ kind: "app" }))).toBe("queued");
    expect(statuses.has(updateTargetKey({ kind: "worker", workerId: "w2" }))).toBe(false);
    expect(updateRunSummary(run, NOW)?.text).toBe("Updating · 0 of 4 done");
  });
});

describe("row status during and after a run", () => {
  test("a row never moves back while a run is active, and its own edge states stay", () => {
    expect(furthestStatus("available", "queued")).toBe("queued");
    expect(furthestStatus("restarting", "updating")).toBe("restarting");
    expect(furthestStatus("updating", "queued")).toBe("updating");
    expect(furthestStatus("current", "updated")).toBe("updated");
    expect(furthestStatus("available", "updated")).toBe("available");
    expect(furthestStatus("Offline", "queued")).toBe("Offline");
    expect(furthestStatus("Offline", "failed")).toBe("failed");
    expect(furthestStatus("available", undefined)).toBe("available");
  });

  test("Updated stays an hour; superseded and dismissed runs no longer speak for rows", () => {
    const finished = new Date(NOW - 10 * 60_000).toISOString();
    const old = new Date(NOW - UPDATED_FRESH_MS - 1).toISOString();

    const run = create(ui.UpdateRunSchema, {
      id: "r",
      state: "failed",
      steps: [
        { kind: "worker", workerId: "a", state: "succeeded", finishedAt: finished },
        { kind: "worker", workerId: "b", state: "succeeded", finishedAt: old },
        { kind: "computer", nodeId: "studio", state: "blocked", finishedAt: finished },
        { kind: "worker", workerId: "c", state: "skipped" },
      ],
    });

    const statuses = runStatuses(run, NOW);
    expect(statuses.get(updateTargetKey({ kind: "worker", workerId: "a" }))).toBe("updated");
    expect(statuses.has(updateTargetKey({ kind: "worker", workerId: "b" }))).toBe(false);
    expect(statuses.get(updateTargetKey({ kind: "computer", nodeId: "studio" }))).toBe("failed");
    expect(runStatuses(create(ui.UpdateRunSchema, { ...run, state: "dismissed" }), NOW).size).toBe(0);
  });
});

describe("one counter", () => {
  const step = (state: string, finishedAt = new Date(NOW - 60_000).toISOString()) =>
    create(ui.UpdateStepSchema, { kind: "worker", state, finishedAt });

  test("running counts finished of planned, queued included; failures only when there are some", () => {
    const run = create(ui.UpdateRunSchema, {
      state: "running",
      steps: [step("succeeded"), step("running"), step("queued"), step("skipped")],
    });

    expect(updateRunSummary(run, NOW)).toEqual({
      text: "Updating · 1 of 3 done",
      tone: "ink",
      progress: (1 / 3) * 100,
    });
    run.steps.push(step("failed"));
    expect(updateRunSummary(run, NOW)?.text).toBe("Updating · 2 of 4 done · 1 failed");
  });

  test("after the run: failures in rose, a fresh success once, then nothing", () => {
    expect(
      updateRunSummary(
        create(ui.UpdateRunSchema, { state: "failed", steps: [step("failed"), step("succeeded")] }),
        NOW,
      ),
    ).toEqual({ text: "1 update failed · 1 updated", tone: "rose", progress: undefined });
    expect(
      updateRunSummary(
        create(ui.UpdateRunSchema, { state: "succeeded", steps: [step("succeeded"), step("succeeded")] }),
        NOW,
      )?.text,
    ).toBe("All 2 updates finished");

    const stale = new Date(NOW - UPDATED_FRESH_MS - 1).toISOString();
    expect(
      updateRunSummary(create(ui.UpdateRunSchema, { state: "succeeded", steps: [step("succeeded", stale)] }), NOW),
    ).toBeUndefined();
  });
});

test("an announced restart stays calm until it is overdue", () => {
  expect(restartDetail(BigInt(NOW - 60_000), NOW)).toEqual({ text: "Restarting to update…", overdue: false });
  expect(restartDetail(0n, NOW).overdue).toBe(false);
  expect(restartDetail(NOW - RESTART_WARNING_MS - 60_000, NOW)).toEqual({
    text: "Still restarting after 4 min. Check that computer.",
    overdue: true,
  });
});
