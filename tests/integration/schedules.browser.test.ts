/** Browser acceptance on an isolated gateway/Postgres/web stack.
 * OA_SCHEDULE_BROWSER=1 bun test tests/integration/schedules.browser.test.ts
 * Requires a web build, /usr/bin/chromium and playwright-core. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider } from "@open-agents/contracts";
import { tempDirs } from "@open-agents/testing";
import { eventually, SCRIPTED_MODELS, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_SCHEDULE_BROWSER"] !== "1")("scheduled tasks browser acceptance", () => {
  const makeTemp = tempDirs();
  const shots = resolve(import.meta.dir, "../../artifacts/schedules-new-thread");
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let desktop: BrowserContext;
  let mobile: BrowserContext;
  let scheduledThreadId: string;
  const problems: string[] = [];
  const base = "http://127.0.0.1:5299";
  const screenshot = (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
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
    scheduledThreadId = (await gw.api.listSchedules({})).schedules.find((s) => s.id === schedule.id)!.recentRuns[0]!.threadId;
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: false } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5299", GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN, ORIGIN: base }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(async () => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20_000)).toBe(true);
    const { chromium } = createRequire(import.meta.url)("playwright-core") as typeof import("playwright-core");
    const options = { executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] };
    desktop = await chromium.launchPersistentContext(makeTemp("oa-schedules-desktop-"), { ...options, viewport: { width: 1440, height: 1000 } });
    mobile = await chromium.launchPersistentContext(makeTemp("oa-schedules-mobile-"), { ...options, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    for (const context of [desktop, mobile]) {
      context.setDefaultTimeout(10_000);
      context.on("page", (page) => page.on("pageerror", (error) => problems.push(error.message)));
    }
  }, 60_000);
  afterAll(async () => {
    await desktop?.close(); await mobile?.close();
    web?.kill(); if (web) await web.exited; await gw?.close();
  }, 30_000);
  test("inspect light/dark, desktop/mobile, creation, history and schedule origin", async () => {
    for (const [size, context] of [["desktop", desktop], ["mobile", mobile]] as const) {
      const page = await context.newPage();
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${base}/settings/schedules`);
        await page.getByText("New thread in Open Agents", { exact: false }).waitFor();
        await screenshot(page, `${size}-${theme}-list`);
        await page.getByRole("button", { name: "New task", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Schedule a task", exact: true });
        await dialog.locator('select[name="target"]').selectOption("new_thread");
        await dialog.getByText("Eligible now: Build server.", { exact: true }).waitFor();
        expect(await dialog.getByRole("button", { name: /effort/i }).count()).toBe(0);
        expect(await page.locator("body").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(await dialog.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
        await screenshot(page, `${size}-${theme}-dialog`);
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
      }
      await page.close();
    }
    const page = await desktop.newPage();
    await page.goto(`${base}/settings/schedules`);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule a task", exact: true });
    await dialog.locator('select[name="target"]').selectOption("new_thread");
    await dialog.getByRole("button", { name: /^Model:/ }).click();
    const search = page.locator('[popover]:popover-open input');
    await search.fill("custom-scheduled-model");
    await search.press("Enter");
    await dialog.getByRole("button", { name: "Model: custom-scheduled-model", exact: true }).waitFor();
    await dialog.getByRole("button", { name: /^Model:/ }).click();
    await search.fill("gpt-6.1-sol");
    await search.press("Enter");
    await dialog.locator('select[name="placement"]').selectOption("specific");
    const workers = dialog.locator('select[name="workspaceId"]');
    expect(await workers.locator("option").count()).toBe(2);
    await workers.selectOption({ label: "laptop · /repo" });
    await dialog.locator('label:has(input[name="kind"][value="recurring"])').click();
    expect(await dialog.locator('select[name="concurrency"]').inputValue()).toBe("skip_if_running");
    await dialog.locator('textarea[name="prompt"]').fill("Check release status and report the result.");
    await dialog.locator('input[name="scheduleName"]').fill("Browser verified schedule");
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const saved = (await gw.api.listSchedules({})).schedules.find((s) => s.name === "Browser verified schedule")!;
    expect(saved).toMatchObject({ target: "new_thread", concurrency: "skip_if_running", prompt: "Check release status and report the result.",
      newThread: { placement: "specific", provider: Provider.CODEX, model: "gpt-6.1-sol" } });
    await page.goto(`${base}/threads/${scheduledThreadId}`);
    await page.getByRole("link", { name: "Started by schedule Morning build check · run 1", exact: true }).waitFor();
    const row = page.getByRole("navigation", { name: "Threads", exact: true }).locator(`a[href="/threads/${scheduledThreadId}"]`);
    expect(await row.locator('[title="Started by schedule Morning build check · run 1"]').count()).toBe(1);
    await screenshot(page, "desktop-origin");
    await page.getByRole("button", { name: "Schedule a task", exact: true }).click();
    expect(await dialog.locator('select[name="target"]').inputValue()).toBe("thread");
    expect(problems).toEqual([]);
    await page.close();
  }, 90_000);
});
