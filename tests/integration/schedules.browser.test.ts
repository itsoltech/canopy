/** Interactive browser fixture on an isolated gateway/Postgres/web stack.
 * OA_SCHEDULE_BROWSER=1 bun test tests/integration/schedules.browser.test.ts
 * Open the printed URL in the shared browser; type `stop` to clean up the stack. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider } from "@open-agents/contracts";
import { eventually, SCRIPTED_MODELS, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_SCHEDULE_BROWSER"] !== "1")("scheduled tasks browser fixture", () => {
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  const base = "http://127.0.0.1:5299";
  beforeAll(async () => {
    gw = await startTestGateway();
    const second = await gw.addWorker("Build server", ["/repo"]);
    await gw.connect(second.workerId, second.credential, "linux", { claude: true, models: [...SCRIPTED_MODELS, {
      provider: Provider.CLAUDE, profileId: "native", models: [{ id: "claude-haiku-5-5", displayName: "Claude Haiku", isDefault: true, efforts: [] }],
    }] });
    const projectId = (await gw.api.createProject({ name: "Open Agents" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    await gw.api.createWorkspace({ projectId, workerId: second.workerId, rootPath: "/repo", label: "Build checkout" });
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.providerInstances.some((i) => i.available)));
    await gw.api.createThread({ projectId, workspaceId, title: "Release checklist", initialMessage: "Review the latest build.", provider: Provider.CODEX });
    const schedule = (await gw.api.createSchedule({ target: "new_thread", name: "Morning build check", prompt: "Check the build and report anything that broke.",
      when: { case: "cron", value: "0 9 * * 1-5" }, timezone: "Europe/Warsaw",
      newThread: { projectId, placement: "least_busy", provider: Provider.CLAUDE, model: "claude-haiku-5-5", permissionMode: PermissionMode.READ_ONLY },
    })).schedule!;
    await gw.core.scheduler.tick(timestampDate(schedule.nextRunAt!));
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: false } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5299", GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN, ORIGIN: base }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(async () => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20_000)).toBe(true);
  }, 60_000);
  afterAll(async () => { web?.kill(); if (web) await web.exited; await gw?.close(); }, 30_000);
  test("inspect light/dark, desktop/mobile, creation, history and schedule origin", async () => {
    console.log(`Schedule browser fixture ready: ${base}/settings/schedules — type stop to finish.`);
    for await (const chunk of Bun.stdin.stream()) if (new TextDecoder().decode(chunk).includes("stop")) break;
  }, 1_200_000);
});
