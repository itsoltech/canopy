import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { answers, eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !proxyUrl || !proxyKey || !dockerAvailable)("a scheduled new thread through CLIProxyAPI", () => {
  const makeTemp = tempDirs();
  let gw: TestGateway;
  let workerId: string;
  let workspaceId: string;
  let projectId: string;
  let stop = async () => {};
  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = makeTemp("oa-schedule-live-repo-");
    const dir = makeTemp("oa-schedule-live-");
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "scheduled-live" })));
    workerId = worker.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo], harnesses: [Provider.CLAUDE] });
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "scheduled-live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, workerId, [Provider.CLAUDE]);
    projectId = (await gw.api.createProject({ name: "Live scheduled tasks" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
  }, 120_000);
  afterAll(async () => { await gw?.core.scheduler.stop(); await stop(); await gw?.close(); }, 30_000);

  test("a once-schedule a minute ahead creates and answers in its own thread", async () => {
    const schedule = (await gw.api.createSchedule({ target: "new_thread", name: "Live schedule", prompt: "Reply with exactly: SCHEDULE_OK. Do not use tools.",
      when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
      newThread: { projectId, placement: "specific", workspaceId, provider: Provider.CLAUDE, providerProfileId: "cliproxyapi",
        model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5", permissionMode: PermissionMode.READ_ONLY },
    })).schedule!;
    expect((await gw.api.listThreads({ projectId })).threads).toHaveLength(0);
    gw.core.scheduler.start();
    const fired = await eventually(async () => (await gw.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === schedule.id)!, (s) => s.runs === 1, 90_000);
    expect(fired.runs).toBe(1);
    const run = fired.recentRuns[0]!;
    expect(run.workerId).toBe(workerId);
    const updates = await watchUntil(gw.api, run.threadId, (u) => u.some((x) => x.change.case === "snapshot" && x.change.value.turns.some((t) => t.status === "completed") || x.change.case === "turn" && x.change.value.status === "completed"), undefined, 120_000);
    expect(answers(updates).join("\n")).toContain("SCHEDULE_OK");
    expect((await gw.api.getThread({ threadId: run.threadId })).thread).toMatchObject({ scheduleId: schedule.id, scheduleRun: 1, parentThreadId: "" });
    expect((await gw.api.listThreads({ projectId })).threads).toHaveLength(1);
    const turns = await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(run.threadId)));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ trigger: "schedule", input: { message: "Reply with exactly: SCHEDULE_OK. Do not use tools." }, status: "completed" });
  }, 240_000);
});
