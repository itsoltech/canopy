import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ThreadWatchLiveness, threadViewDiverged } from "./thread-watch-liveness.ts";
import { ThreadWatchRecovery } from "./thread-watch-recovery.ts";

const cursor = (appliedSeq: bigint, epoch = "epoch") =>
  create(ui.ThreadSyncCursorSchema, { threadId: "thread", epoch, appliedSeq });

test("transport losses do not exhaust the scoped repair budget or hide deterministic failures", () => {
  const recovery = new ThreadWatchRecovery();

  for (let attempt = 0; attempt < 5; attempt++) {
    recovery.advanced(BigInt(attempt), attempt * 1000);
    expect(recovery.failed({ code: 14, transport: true }).action).toBe("resume");
  }

  expect(recovery.failed({ code: 15, reason: "invalid_range" }).action).toBe("resume");
  expect(recovery.failed({ code: 14, transport: true }).action).toBe("resume");
  expect(recovery.failed({ code: 15, reason: "invalid_range" }).action).toBe("resume");
  expect(recovery.failed({ code: 15, reason: "invalid_range" }).action).toBe("stop");
  expect(new ThreadWatchRecovery().failed({ code: 7, transport: true }).action).toBe("stop");
});

test("head lag repairs only a stalled applied cursor, backs off, reloads and never gives up", () => {
  const guard = new ThreadWatchLiveness();
  const applied = cursor(1n);
  const head = cursor(20n);
  expect(guard.check(applied, head, 0)).toBeUndefined();
  expect(guard.check(applied, head, 9999)).toBeUndefined();
  expect(guard.check(applied, head, 10000)).toEqual({ lagMs: 10000, attempt: 1, reload: false });
  expect(guard.check(applied, cursor(21n), 39999)).toBeUndefined();
  expect(guard.check(applied, head, 40000)).toMatchObject({ attempt: 2, reload: false });
  expect(guard.check(applied, head, 99999)).toBeUndefined();
  expect(guard.check(applied, head, 100000)).toMatchObject({ attempt: 3, reload: true });
  // Capped backoff: a view that stays stuck keeps being repaired.
  expect(guard.check(applied, head, 220000)).toMatchObject({ attempt: 4, reload: true });
  expect(guard.check(applied, head, 460000)).toMatchObject({ attempt: 5, reload: true });
  expect(guard.check(applied, head, 760000)).toMatchObject({ attempt: 6, reload: true });
  guard.pause();
  expect(guard.check(applied, head, 1000000)).toBeUndefined();
  expect(guard.check(applied, head, 1010000)).toBeUndefined();
  expect(guard.check(applied, head, 1060000)).toMatchObject({ attempt: 7, reload: true });
  // Progress restarts the clock and the budget.
  expect(guard.check(cursor(2n), head, 1070000)).toBeUndefined();
  expect(guard.check(cursor(2n), head, 1080000)).toMatchObject({ attempt: 1, reload: false });
  expect(guard.check(head, head, 1090000)).toBeUndefined();
  expect(guard.check(applied, cursor(20n, "other"), 1100000)).toBeUndefined();
  expect(guard.check(applied, undefined, 1110000)).toBeUndefined();
});

test("an overview status the view contradicts repairs even when the cursor looks current or advances", () => {
  const guard = new ThreadWatchLiveness();
  const head = cursor(20n);
  expect(guard.check(head, head, 0, true)).toBeUndefined();
  expect(guard.check(cursor(21n), cursor(21n), 10000, true)).toMatchObject({ attempt: 1, reload: false });
  expect(guard.check(cursor(22n), cursor(22n), 40000, true)).toMatchObject({ attempt: 2, reload: false });
  // A reload drops the cursor; the contradiction still counts.
  expect(guard.check(undefined, head, 100000, true)).toMatchObject({ attempt: 3, reload: true });
  expect(guard.check(head, head, 110000, false)).toBeUndefined();
  expect(guard.check(head, head, 120000, true)).toBeUndefined();
  expect(guard.check(head, head, 130000, true)).toMatchObject({ attempt: 1, reload: false });
});

test("only clear status contradictions count as a diverged view", () => {
  expect(threadViewDiverged("running", false)).toBe(true);
  expect(threadViewDiverged("running", true)).toBe(false);

  for (const settled of ["idle", "interrupted", "failed"]) {
    expect(threadViewDiverged(settled, true)).toBe(true);
    expect(threadViewDiverged(settled, false)).toBe(false);
  }

  for (const unclear of ["waiting_input", "creating", "archived", "", undefined])
    expect(threadViewDiverged(unclear, true) || threadViewDiverged(unclear, false)).toBe(false);
});
