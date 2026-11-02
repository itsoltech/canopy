import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@open-agents/contracts";
import { scheduleWorkerEligible, selectScheduleWorkspace } from "@open-agents/domain";

describe("schedule placement", () => {
  const candidates = [{ id: "b", worker_id: "B", load: 3 }, { id: "a", worker_id: "A", load: 3 }, { id: "c", worker_id: "C", load: 8 }];
  test("any and least-busy ties have a stable workspace order", () => {
    expect(selectScheduleWorkspace("any", candidates, null)?.id).toBe("a");
    expect(selectScheduleWorkspace("least_busy", candidates, null)?.id).toBe("a");
    expect(selectScheduleWorkspace("least_busy", [...candidates, { id: "d", worker_id: "D", load: 0 }], null)?.id).toBe("d");
    expect(selectScheduleWorkspace("any", [], null)).toBeUndefined();
  });
  test("round robin resumes from the persisted workspace id, wraps and tolerates missing workers", () => {
    expect(selectScheduleWorkspace("round_robin", candidates, null)?.id).toBe("a");
    expect(selectScheduleWorkspace("round_robin", candidates, "a")?.id).toBe("b");
    expect(selectScheduleWorkspace("round_robin", candidates, "c")?.id).toBe("a");
    expect(selectScheduleWorkspace("round_robin", candidates.filter((w) => w.id !== "b"), "b")?.id).toBe("c");
  });
  test("eligibility requires online, enabled instance and available harness/instance; specific accepts offline", () => {
    const spec = create(ui.NewThreadScheduleSchema, { provider: Provider.CODEX });
    const worker = create(ui.WorkerSchema, { online: true, providers: [{ provider: Provider.CODEX, available: true }], providerInstances: [{ harness: Provider.CODEX, id: "native", enabled: true, available: true }] });
    expect(scheduleWorkerEligible(worker, spec)).toBe(true);
    expect(scheduleWorkerEligible({ ...worker, online: false }, spec)).toBe(false);
    expect(scheduleWorkerEligible({ ...worker, online: false }, spec, false)).toBe(true);
    expect(scheduleWorkerEligible({ ...worker, providers: [] }, spec)).toBe(false);
    expect(scheduleWorkerEligible({ ...worker, providerInstances: [{ ...worker.providerInstances[0]!, enabled: false }] }, spec)).toBe(false);
    expect(scheduleWorkerEligible({ ...worker, providerInstances: [{ ...worker.providerInstances[0]!, available: false }] }, spec)).toBe(false);
    expect(scheduleWorkerEligible(worker, { ...spec, providerProfileId: "other" })).toBe(false);
  });
});
