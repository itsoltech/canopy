/// <reference lib="dom" />
/** OA_SCRATCH_BROWSER=1 bun test tests/integration/no-project-threads.browser.test.ts
 * Private throwaway gateway/Postgres/scripted worker and production web build on port 5391. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_SCRATCH_BROWSER"] !== "1")("No project browser", () => {
  const base = "http://127.0.0.1:5391";
  const shots = resolve(import.meta.dir, "../../artifacts/no-project-threads");
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser;
  let project: ui.Project;
  let workspace: ui.Workspace;
  let regular: ui.Project;
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    project = (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!;
    workspace = project.workspaces.find((w) => w.workerId === gw.workerId)!;
    regular = (await gw.api.createProject({ name: "Example project" })).project!;
    await gw.api.createWorkspace({ projectId: regular.id, workerId: gw.workerId, rootPath: "/repo/example" });
    const offline = await gw.addWorker("Offline server", ["/srv"]);
    expect(offline.workerId).toBeTruthy();
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX, title: "Scratch machine setup", initialMessage: "Inspect this machine" })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5391", SHUTDOWN_TIMEOUT: "1", PROTOCOL_HEADER: "x-forwarded-proto", GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN },
      stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20_000)).toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
    await gw?.close();
  }, 30_000);
  const shot = (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  const overflow = async (page: Page) => {
    expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await page.locator("select").count()).toBe(0);
  };
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: picker, worker, creation, sidebar filter, path, defaults and schedule`, async () => {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version,
        appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT },
        sidebar: { projectIds: [] }, threadDefaults: { workspaceId: workspace.id },
      });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390,
        extraHTTPHeaders: { "x-forwarded-proto": "http" } });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const prefix = `${width}-${theme}`;
      try {
        await page.goto(base);
        await page.getByRole("button", { name: "Project: No project", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "Choose a project", exact: true });
        expect(await picker.getByRole("option").first().innerText()).toContain("No project");
        expect(await picker.locator(".border-dashed").count()).toBe(1);
        await shot(page, `${prefix}-picker`);
        await picker.getByRole("option").filter({ hasText: "Example project" }).click();
        await page.getByRole("button", { name: "Project: Example project", exact: true }).click();
        await page.getByRole("option").filter({ hasText: "No project" }).click();
        await page.getByRole("button", { name: "Worker: laptop, online", exact: true }).click();
        const workers = page.getByRole("dialog", { name: "Choose a worker", exact: true });
        await workers.getByRole("option").filter({ hasText: "Offline server" }).click();
        await page.getByText("Offline server is offline.", { exact: false }).waitFor();
        await page.getByRole("button", { name: "Worker: Offline server, offline", exact: true }).click();
        await page.getByRole("dialog", { name: "Choose a worker", exact: true }).getByRole("option").filter({ hasText: "laptop" }).click();
        await page.getByRole("textbox", { name: "Task for the agent", exact: true }).fill("Inspect the scratch directory");
        await overflow(page);
        await shot(page, `${prefix}-composer`);
        const submitted = page.waitForResponse((response) => response.url().includes("?/createThread"));
        await page.getByRole("button", { name: "Send", exact: true }).click();
        const response = await submitted;
        const result = await response.json() as { type?: string; status?: number; data?: unknown };
        expect(result.type, JSON.stringify(result)).toBe("redirect");
        await page.waitForURL(/\/threads\//, { waitUntil: "domcontentloaded" });
        const threadId = new URL(page.url()).pathname.split("/").at(-1)!;
        const thread = (await gw.api.getThread({ threadId })).thread!;
        expect(thread.cwd).toBe(`${workspace.rootPath}/${thread.id}`);
        if (width === 390) await page.getByRole("button", { name: "Thread details", exact: true }).click();
        const panel = width === 390 ? page.getByRole("dialog") : page.getByRole("complementary", { name: "Thread details", exact: true });
        await panel.getByText(thread.cwd, { exact: true }).waitFor();
        await panel.getByText("Scratch files are kept", { exact: false }).waitFor();
        await shot(page, `${prefix}-path`);
        if (width === 390) {
          await panel.getByRole("button", { name: "Close", exact: true }).click();
          await page.getByRole("button", { name: "Open menu", exact: true }).click();
        }
        await page.getByRole("button", { name: "Filter projects", exact: true }).click();
        const filter = page.getByRole("dialog", { name: "Filter threads", exact: true });
        await filter.getByRole("checkbox", { name: "No project", exact: true }).click();
        expect(await filter.locator(".border-dashed").count()).toBe(1);
        await shot(page, `${prefix}-filter`);
        await page.keyboard.press("Escape");
        await page.goto(`${base}/settings/threads`);
        const defaults = page.getByRole("combobox", { name: "Default project and worker", exact: true });
        await defaults.click();
        expect(await page.getByRole("group", { name: "No project", exact: true }).count()).toBe(1);
        await shot(page, `${prefix}-defaults`);
        await page.keyboard.press("Escape");
        await page.goto(`${base}/settings/projects`);
        expect(await page.locator(`a[href="/settings/projects/${project.id}"]`).count()).toBe(0);
        await page.goto(`${base}/settings/schedules`);
        await page.getByRole("button", { name: "New task", exact: true }).click();
        const schedule = page.getByRole("dialog", { name: "Schedule a task", exact: true });
        await schedule.getByRole("combobox", { name: "Run the task", exact: true }).click();
        await page.getByRole("option", { name: "Start a new thread each run", exact: true }).click();
        await schedule.getByRole("combobox", { name: "Project", exact: true }).waitFor();
        expect(await schedule.getByRole("combobox", { name: "Project", exact: true }).innerText()).toContain("No project");
        expect(await schedule.getByRole("combobox", { name: "Placement", exact: true }).count()).toBe(0);
        await schedule.getByRole("combobox", { name: "Worker", exact: true }).waitFor();
        await overflow(page);
        await shot(page, `${prefix}-schedule`);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 120_000);
  }
});
