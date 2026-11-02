/// <reference lib="dom" />
/** Opt-in regression on a private Postgres/gateway/scripted worker + web on 5317.
 * OA_FORM_BROWSER=1 bun test tests/integration/custom-form-controls.browser.test.ts
 * OA_FORM_BROWSER_HOLD=1 keeps that fixture for shared preview until .tmp/form-browser-stop exists. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ItemStatus, Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_FORM_BROWSER"] !== "1")("custom form controls browser", () => {
  const base = "http://127.0.0.1:5317";
  const shots = resolve(import.meta.dir, "../../artifacts/custom-form-controls");
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser;
  let threadId: string;
  let turnId: string;
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    const projectId = (await gw.api.createProject({ name: "Custom controls QA" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    gw.worker.holdTurns = true;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Form controls review", initialMessage: "Review the controls" })).thread!.id;
    turnId = (await eventually(async () => [...gw.worker.started.keys()][0], Boolean))!;
    gw.worker.emit(threadId, turnId, { case: "itemCompleted", value: { item: { itemId: "tasks", status: ItemStatus.COMPLETED,
      content: { case: "agentMessage", value: { text: "## Review checklist\n\n- [x] Custom dropdown options\n- [ ] Keyboard and touch controls", phase: "commentary" } },
    } } });
    await gw.worker.callTool({ threadId, turnId, tool: "ask_user", args: { wait: false, questions: [{ id: "controls", header: "Controls", question: "Which controls should we review?", kind: "multiple_choice", options: [{ label: "Keyboard", description: "Use arrow keys and Enter." }, { label: "Touch", description: "Use bottom sheets and large targets." }] }] } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "0.0.0.0", PORT: "5317", SHUTDOWN_TIMEOUT: "1", ORIGIN: base, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20000)).toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
    console.info(`FORM PREVIEW ${base}/threads/${threadId}`);
  }, 60000);
  afterAll(async () => {
    if (Bun.env["OA_FORM_BROWSER_HOLD"] === "1") {
      console.info(`FORM PREVIEW READY ${base}/threads/${threadId}; stop: .tmp/form-browser-stop`);
      while (!existsSync(resolve(import.meta.dir, "../../.tmp/form-browser-stop"))) await Bun.sleep(250);
    }
    await browser?.close(); web?.kill(); if (web) await web.exited;
    if (gw) { gw.worker.finish(threadId, turnId); await gw.close(); }
  }, 1_800_000);
  const shot = (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  async function pick(page: Page, label: string, option: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function noOverflow(page: Page) {
    expect(await page.locator("body").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await page.locator("select").count()).toBe(0);
    expect(await page.locator('input[type="date"], input[type="datetime-local"], input[type="time"], input[type="number"]').count()).toBe(0);
  }
  async function threadAction(page: Page, action: string) {
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  }
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: forms, bindings, keyboard, locale and sheets`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390, locale: "en-GB", timezoneId: "Europe/Warsaw" });
      context.setDefaultTimeout(8000);
      const problems: string[] = [];
      await context.addInitScript(() => window.addEventListener("vite:preloadError", (event) => console.error("preloadError", (event as Event & { payload?: Error }).payload)));
      context.on("page", (page) => page.on("pageerror", (error) => {
        problems.push(error.stack || error.message);
        console.error(error.stack || error.message);
      }));
      context.on("page", (page) => page.on("console", (message) => {
        if (message.type() === "error" && message.text().startsWith("preloadError")) console.error(message.text());
      }));
      const page = await context.newPage();
      const prefix = `${width}-${theme}`;
      try {
        const settings = (await gw.api.getSettings({})).user!;
        await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
        await page.goto(`${base}/settings/threads`);
        await page.locator("dialog:modal").waitFor();
        const permissions = page.getByRole("combobox", { name: "Default permissions", exact: true });
        await permissions.focus(); await permissions.press("Enter");
        await page.locator('[role="combobox"][aria-label="Default permissions"][aria-expanded="true"]').waitFor();
        if (width === 390) expect(await page.locator('[popover]:popover-open').getAttribute("data-sheet")).not.toBeNull();
        await shot(page, `${prefix}-select`);
        await permissions.press("End"); await permissions.press("Home"); await permissions.press("r");
        await permissions.press("Escape"); expect(await permissions.getAttribute("aria-expanded")).toBe("false");
        expect(await permissions.evaluate((node) => node === document.activeElement)).toBe(true);
        await permissions.press("Enter"); await permissions.press("Home"); await permissions.press("ArrowDown"); await permissions.press("Enter");
        await noOverflow(page);

        await page.goto(`${base}/settings/appearance`);
        await pick(page, "Chat width", "Wide");
        await page.getByRole("radio", { name: "System", exact: true }).waitFor();
        await shot(page, `${prefix}-appearance`);
        await noOverflow(page);

        await page.goto(`${base}/settings/providers`);
        await pick(page, "Applying settings on", "laptop");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        const provider = page.getByRole("dialog", { name: "Add provider", exact: true });
        await provider.getByRole("button", { name: "Continue", exact: true }).click();
        await provider.getByRole("radio", { name: /No color/ }).waitFor();
        await provider.getByRole("radio", { name: /Color #/ }).first().press("Space");
        await shot(page, `${prefix}-provider`);
        await provider.getByRole("button", { name: "Close", exact: true }).click();
        await noOverflow(page);

        await page.goto(`${base}/settings/schedules`);
        await page.getByRole("button", { name: "New task", exact: true }).click();
        const schedule = page.getByRole("dialog", { name: "Schedule a task", exact: true });
        await schedule.getByRole("combobox", { name: "Run at", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "Choose Run at", exact: true });
        await picker.getByRole("button", { name: "Tomorrow 9:00", exact: true }).click();
        const day = picker.locator('[role="grid"] button[tabindex="0"]');
        await day.focus(); await day.press("ArrowRight"); await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Home"); await page.keyboard.press("End"); await page.keyboard.press("PageDown"); await page.keyboard.press("Enter");
        expect(await picker.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
        await shot(page, `${prefix}-calendar`);
        await picker.getByRole("button", { name: "Apply", exact: true }).click();
        expect(await schedule.locator('input[type="hidden"][name="runAt"]').inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);
        await schedule.getByRole("radio", { name: "Repeat", exact: true }).press("Space");
        await pick(page, "How often", "Every hour");
        const minute = schedule.getByRole("spinbutton", { name: "At minute", exact: true });
        await minute.fill("99"); await minute.press("Tab"); expect(await minute.inputValue()).toBe("59");
        await minute.press("ArrowDown"); expect(await minute.inputValue()).toBe("58");
        await pick(page, "How often", "Every week");
        await schedule.getByRole("combobox", { name: "At", exact: true }).click();
        const time = page.getByRole("dialog", { name: "Choose At", exact: true });
        await time.getByRole("textbox", { name: "Time", exact: true }).fill("25:00");
        expect(await time.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
        await time.getByRole("textbox", { name: "Time", exact: true }).fill("14:25");
        await time.getByRole("button", { name: "Apply", exact: true }).click();
        await pick(page, "On", "Friday"); await pick(page, "Ends", "After a number of runs");
        await schedule.getByRole("spinbutton", { name: "Runs", exact: true }).fill("0");
        await schedule.getByRole("spinbutton", { name: "Runs", exact: true }).press("Tab");
        expect(await schedule.getByRole("spinbutton", { name: "Runs", exact: true }).inputValue()).toBe("1");
        await pick(page, "Run the task", "Start a new thread each run");
        await pick(page, "Placement", "Specific worker");
        await shot(page, `${prefix}-schedule`); await noOverflow(page);
        await schedule.getByRole("button", { name: "Cancel", exact: true }).click();

        await page.goto(`${base}/threads/${threadId}`);
        await threadAction(page, "New side thread");
        const side = page.getByRole("dialog", { name: "New side thread", exact: true });
        await pick(page, "Permissions", "Read only");
        expect(await side.locator('input[type="hidden"][name="permissionMode"]').inputValue()).toBe("READ_ONLY");
        await side.getByRole("checkbox", { name: "Continue from the main thread's history", exact: true }).press("Space");
        await shot(page, `${prefix}-side-thread`);
        await side.getByRole("button", { name: "Cancel", exact: true }).click();
        await threadAction(page, "Permissions…");
        const permissionDialog = page.getByRole("dialog", { name: "Permissions", exact: true });
        await permissionDialog.getByRole("radio", { name: /Read only/ }).press("Space");
        await shot(page, `${prefix}-permissions`);
        await permissionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await threadAction(page, "Set a goal…");
        const goal = page.getByRole("dialog", { name: "Set a goal", exact: true });
        const budget = goal.getByRole("spinbutton", { name: /Token budget/ });
        await budget.fill("1500"); await budget.press("ArrowUp"); expect(await budget.inputValue()).toBe("2000");
        await budget.fill("-10"); await budget.press("Tab"); expect(await budget.inputValue()).toBe("0");
        await shot(page, `${prefix}-goal`);
        await goal.getByRole("button", { name: "Cancel", exact: true }).click();
        const task = page.getByRole("checkbox", { name: "Done", exact: true });
        expect(await task.evaluate((node) => getComputedStyle(node).appearance)).toBe("none");
        const question = page.getByRole("checkbox", { name: /Keyboard/ });
        await question.press("Space"); expect(await question.isChecked()).toBe(true);
        expect(await question.evaluate((node) => getComputedStyle(node).appearance)).toBe("none");
        await shot(page, `${prefix}-question`); await noOverflow(page);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await threadAction(page, "New side thread");
        await side.getByRole("combobox", { name: "Permissions", exact: true }).click();
        expect(await page.locator('[popover]:popover-open').evaluate((node) => getComputedStyle(node).scale)).toBe("1");
        expect(problems).toEqual([]);
      } catch (error) { await shot(page, `${prefix}-failure`); throw error; }
      finally { await context.close(); }
    }, 90000);
  }
});
