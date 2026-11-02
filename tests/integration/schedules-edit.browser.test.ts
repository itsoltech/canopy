/** OA_SCHEDULE_EDIT_BROWSER=1 bun test tests/integration/schedules-edit.browser.test.ts
 * Own throwaway Postgres/gateway/scripted workers, web on 5298, Chromium on the requested path. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";
import { tempDirs } from "@open-agents/testing";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_SCHEDULE_EDIT_BROWSER"] !== "1")("schedule edit browser acceptance", () => {
  const makeTemp = tempDirs();
  const shots = resolve(import.meta.dir, "../../artifacts/schedules-edit");
  const base = "http://127.0.0.1:5298";
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let desktop: BrowserContext;
  let mobile: BrowserContext;
  let project: ui.Project;
  let workspace: ui.Workspace;
  let thread: ui.Thread;
  const problems: string[] = [];
  const screenshot = (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  const current = async (id: string) => (await gw.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === id)!;
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    project = (await gw.api.createProject({ name: "Schedule editing" })).project!;
    workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })).workspace!;
    thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, title: "Release review", provider: Provider.CODEX })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.providerInstances.some((i) => i.available)));
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: false } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5298", GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN, ORIGIN: base }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(async () => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20_000)).toBe(true);
    const { chromium } = createRequire(import.meta.url)("playwright-core") as typeof import("playwright-core");
    const options = { executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] };
    desktop = await chromium.launchPersistentContext(makeTemp("oa-schedule-edit-desktop-"), { ...options, viewport: { width: 1440, height: 1000 } });
    mobile = await chromium.launchPersistentContext(makeTemp("oa-schedule-edit-mobile-"), { ...options, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    for (const context of [desktop, mobile]) {
      context.setDefaultTimeout(10_000);
      context.on("page", (page) => page.on("pageerror", (error) => problems.push(error.message)));
    }
  }, 60_000);
  afterAll(async () => {
    await desktop?.close(); await mobile?.close();
    web?.kill(); if (web) await web.exited; await gw?.close();
  }, 30_000);

  test("edits from Settings and the thread panel; menu, pause/resume, cancel confirmation in both themes and sizes", async () => {
    for (const [size, context] of [["desktop", desktop], ["mobile", mobile]] as const) {
      for (const theme of ["light", "dark"] as const) {
        const prefix = `${size}-${theme}`;
        const fresh = (await gw.api.createSchedule({ target: "new_thread", prompt: "Check the release build", name: `${prefix} build check`,
          when: { case: "cron", value: "30 9 * * 1-5" }, timezone: "Europe/Warsaw", maxRuns: 7, missedPolicy: "skip", concurrency: "allow",
          newThread: { projectId: project.id, placement: "specific", workspaceId: workspace.id, provider: Provider.CODEX, model: "gpt-5.5", effort: "high", permissionMode: PermissionMode.READ_ONLY, title: "Scheduled release" },
        })).schedule!;
        const inThread = (await gw.api.createSchedule({ threadId: thread.id, name: `${prefix} thread task`, prompt: "Report release status", when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 3_600_000)) } })).schedule!;
        const page = await context.newPage();
        try {
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${base}/settings/schedules`);
          const row = page.getByRole("listitem").filter({ has: page.getByText(fresh.name, { exact: true }) });
          await row.getByText("Active", { exact: true }).waitFor();
          await screenshot(page, `${prefix}-list`);
          await row.getByRole("button", { name: "Scheduled task actions", exact: true }).click();
          const menu = page.getByRole("menu", { name: "Scheduled task actions", exact: true });
          expect((await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim())).toEqual(["Edit…", "Pause", "Cancel schedule…"]);
          await screenshot(page, `${prefix}-menu`);
          await menu.getByRole("menuitem", { name: "Edit…", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Edit scheduled task", exact: true });
          await dialog.waitFor();
          expect(await dialog.locator('textarea[name="prompt"]').inputValue()).toBe(fresh.prompt);
          expect(await dialog.locator('input[name="scheduleName"]').inputValue()).toBe(fresh.configuredName);
          expect(await dialog.locator('select[name="projectId"]').inputValue()).toBe(project.id);
          expect(await dialog.locator('select[name="placement"]').inputValue()).toBe("specific");
          expect(await dialog.locator('select[name="workspaceId"]').inputValue()).toBe(workspace.id);
          expect(await dialog.locator('input[name="threadTitle"]').inputValue()).toBe("Scheduled release");
          expect(await dialog.locator('input[name="cron"]').inputValue()).toBe("30 9 * * 1-5");
          expect(await dialog.locator('select[name="timezone"]').inputValue()).toBe("Europe/Warsaw");
          expect(await dialog.locator('input[name="maxRuns"]').inputValue()).toBe("7");
          expect(await dialog.locator('select[name="missedPolicy"]').inputValue()).toBe("skip");
          expect(await dialog.locator('select[name="concurrency"]').inputValue()).toBe("allow");
          await dialog.getByText("Next runs", { exact: true }).waitFor();
          expect(await dialog.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
          await screenshot(page, `${prefix}-edit`);
          await dialog.locator('textarea[name="prompt"]').fill(`Edited ${prefix} build`);
          await dialog.locator('input[name="scheduleName"]').fill(`${prefix} updated build`);
          await dialog.locator('select[name="placement"]').selectOption("round_robin");
          await dialog.locator('input[name="cron"]').fill("0 11 * * 1-5");
          await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          expect(await current(fresh.id)).toMatchObject({ name: `${prefix} updated build`, prompt: `Edited ${prefix} build`, cron: "0 11 * * 1-5", newThread: { placement: "round_robin", model: "gpt-5.5", effort: "high", permissionMode: PermissionMode.READ_ONLY, title: "Scheduled release" } });
          const updatedRow = page.getByRole("listitem").filter({ has: page.getByText(`${prefix} updated build`, { exact: true }) });
          await updatedRow.getByRole("button", { name: "Scheduled task actions" }).click();
          await menu.getByRole("menuitem", { name: "Pause", exact: true }).click();
          await updatedRow.getByText("Paused", { exact: true }).waitFor();
          await updatedRow.getByRole("button", { name: "Scheduled task actions" }).click();
          expect((await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim())).toEqual(["Edit…", "Resume", "Cancel schedule…"]);
          await menu.getByRole("menuitem", { name: "Resume", exact: true }).click();
          await updatedRow.getByText("Active", { exact: true }).waitFor();
          await updatedRow.getByRole("button", { name: "Scheduled task actions" }).click();
          await menu.getByRole("menuitem", { name: "Cancel schedule…", exact: true }).click();
          const confirmation = page.getByRole("dialog", { name: "Cancel scheduled task?", exact: true });
          await confirmation.waitFor();
          await screenshot(page, `${prefix}-cancel`);
          await confirmation.getByRole("button", { name: "Keep task", exact: true }).click();
          await confirmation.waitFor({ state: "hidden" });
          expect((await current(fresh.id)).status).toBe("active");
          await updatedRow.getByRole("button", { name: "Scheduled task actions" }).click();
          await menu.getByRole("menuitem", { name: "Cancel schedule…", exact: true }).click();
          await confirmation.getByRole("button", { name: "Cancel schedule", exact: true }).click();
          await eventually(() => current(fresh.id), (s) => s.status === "cancelled");
          await page.locator('label:has(input[name="view"][value="finished"])').click();
          expect(await page.getByRole("button", { name: "Scheduled task actions", exact: true }).count()).toBe(0);

          await page.goto(`${base}/threads/${thread.id}`);
          if (size === "mobile") await page.getByRole("button", { name: "Thread details", exact: true }).click();
          const panel = size === "mobile" ? page.getByRole("dialog", { name: thread.title, exact: true }) : page.getByRole("complementary", { name: "Thread details", exact: true });
          const panelRow = panel.getByRole("listitem").filter({ has: page.getByText(inThread.name, { exact: true }) });
          await panelRow.getByRole("button", { name: "Scheduled task actions" }).click();
          await menu.getByRole("menuitem", { name: "Edit…", exact: true }).click();
          await dialog.waitFor();
          expect(await dialog.locator('textarea[name="prompt"]').inputValue()).toBe(inThread.prompt);
          await dialog.locator('textarea[name="prompt"]').fill(`Edited ${prefix} thread message`);
          await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          expect((await current(inThread.id)).prompt).toBe(`Edited ${prefix} thread message`);
          await screenshot(page, `${prefix}-thread-panel`);
          expect(await page.locator("body").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
          await gw.api.setScheduleStatus({ scheduleId: inThread.id, status: "cancelled" });
        } catch (error) {
          await screenshot(page, `${prefix}-failure`);
          throw error;
        } finally { await page.close(); }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  test("keeps a conflicting draft and saves an edit of a paused task without resuming it", async () => {
    const initial = (await gw.api.createSchedule({ threadId: thread.id, prompt: "Conflict task", name: "Conflict task",
      when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 3_600_000)) } })).schedule!;
    const page = await desktop.newPage();
    try {
      await page.goto(`${base}/settings/schedules`);
      const menu = page.getByRole("menu", { name: "Scheduled task actions", exact: true });
      const dialog = page.getByRole("dialog", { name: "Edit scheduled task", exact: true });
      const row = page.getByRole("listitem").filter({ has: page.getByText("Conflict task", { exact: true }) });
      await row.getByRole("button", { name: "Scheduled task actions" }).click();
      await menu.getByRole("menuitem", { name: "Edit…", exact: true }).click();
      await dialog.locator('textarea[name="prompt"]').fill("My unsaved draft");
      await gw.api.updateSchedule({ scheduleId: initial.id, expectedVersion: initial.version,
        configuration: { threadId: thread.id, name: "Conflict task", prompt: "Other editor saved this", when: { case: "runAt", value: initial.runAt! } } });
      await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
      await dialog.getByRole("alert").getByText(/changed meanwhile/).waitFor();
      expect(await dialog.locator('textarea[name="prompt"]').inputValue()).toBe("My unsaved draft");
      expect((await current(initial.id)).prompt).toBe("Other editor saved this");
      await screenshot(page, "desktop-conflict");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await row.getByRole("button", { name: "Scheduled task actions" }).click();
      await menu.getByRole("menuitem", { name: "Pause", exact: true }).click();
      await row.getByText("Paused", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Scheduled task actions" }).click();
      await menu.getByRole("menuitem", { name: "Edit…", exact: true }).click();
      expect(await dialog.locator('textarea[name="prompt"]').inputValue()).toBe("Other editor saved this");
      await dialog.locator('textarea[name="prompt"]').fill("Edited while paused");
      await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await current(initial.id)).toMatchObject({ status: "paused", prompt: "Edited while paused" });
      expect((await current(initial.id)).nextRunAt).toBeUndefined();
      await gw.api.setScheduleStatus({ scheduleId: initial.id, status: "cancelled" });
      expect(problems).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
