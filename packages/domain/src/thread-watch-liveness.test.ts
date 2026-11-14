import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ThreadWatchLiveness } from "./thread-watch-liveness.ts";
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

test("head divergence repairs only a stalled applied cursor, with bounded retries and no inactive time", () => {
  const guard = new ThreadWatchLiveness();
  const applied = cursor(1n);
  const head = cursor(20n);
  expect(guard.check(applied, head, 0)).toBeUndefined();
  expect(guard.check(applied, head, 9999)).toBeUndefined();
  expect(guard.check(applied, head, 10000)?.attempt).toBe(1);
  expect(guard.check(applied, cursor(21n), 39999)).toBeUndefined();
  expect(guard.check(applied, head, 40000)?.attempt).toBe(2);
  expect(guard.check(applied, head, 70000)?.attempt).toBe(3);
  expect(guard.check(applied, cursor(99n), 100000)).toBeUndefined();
  guard.pause();
  expect(guard.check(applied, head, 200000)).toBeUndefined();
  expect(guard.check(applied, head, 210000)).toBeUndefined();
  expect(guard.check(cursor(2n), head, 220000)).toBeUndefined();
  expect(guard.check(cursor(2n), head, 230000)?.attempt).toBe(1);
  expect(guard.check(head, head, 240000)).toBeUndefined();
  expect(guard.check(applied, cursor(20n, "other"), 250000)).toBeUndefined();
  expect(guard.check(applied, undefined, 260000)).toBeUndefined();
});
