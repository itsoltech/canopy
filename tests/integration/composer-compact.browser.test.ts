/// <reference lib="dom" />
/** Opt-in acceptance: private Postgres/gateway/scripted worker + web on 5297.
 * OA_COMPOSER_BROWSER=1 bun test tests/integration/composer-compact.browser.test.ts
 * Requires apps/web build and /usr/bin/chromium. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ItemDeltaField, ItemStatus, Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_COMPOSER_BROWSER"] !== "1")("compact composer browser", () => {
  const shots = resolve(import.meta.dir, "../../artifacts/composer-compact");
  const base = "http://127.0.0.1:5297";
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser;
  let threadId: string;
  let turnId: string;
  const problems: string[] = [];
  let panelsSeeded = false;
  async function seedPanels() {
    if (panelsSeeded) return;
    for (let i = 0; i < 3; i++) await gw.api.sendMessage({ threadId, text: `Queued review ${i + 1}`, clientRequestId: crypto.randomUUID() });
    await gw.worker.callTool({ threadId, turnId, tool: "spawn_thread", args: { title: "Review accessibility", prompt: "Review keyboard and mobile layout", notify: false } });
    panelsSeeded = true;
  }

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    const projectId = (await gw.api.createProject({ name: "Composer review" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    gw.worker.holdTurns = true;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "A readable conversation", initialMessage: "Review the implementation and explain your findings." })).thread!.id;
    turnId = (await eventually(async () => [...gw.worker.started.keys()][0], Boolean))!;
    for (let i = 0; i < 50; i++) {
      gw.worker.emit(threadId, turnId, { case: "itemCompleted", value: { item: {
        itemId: `history-${i}`, status: ItemStatus.COMPLETED,
        content: { case: "agentMessage", value: { phase: "commentary", text: `### Finding ${i + 1}\n\nThe conversation should stay readable while the agent works. Keep the current paragraph in place when the composer changes size.\n\nUse the same draft, keyboard navigation and attachment controls on every screen.` } },
      } } });
    }
    gw.worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "stream", status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { text: "Working through the remaining findings…", phase: "commentary" } } } } });
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: true } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5297", ORIGIN: base, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20000)).toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
    if (gw) { gw.worker.finish(threadId, turnId); await gw.close(); }
  }, 30000);

  async function compact(page: Page, touch: boolean) {
    const feed = page.getByRole("region", { name: "Timeline", exact: true });
    await feed.hover({ position: { x: 150, y: 150 } });
    // Snapshot the reading row in the scroll event, before the resize starts. Check the same row
    // after the transition, rather than comparing scrollTop (virtual padding may legitimately change).
    await feed.evaluate((node) => {
      node.addEventListener("scroll", () => {
        const edge = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.getBoundingClientRect().bottom > edge + 1);
        if (row) node.setAttribute("data-reading-before", JSON.stringify({ key: row.dataset["key"], top: row.getBoundingClientRect().top }));
      }, { once: true });
    });
    if (touch) {
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 180 }] });
      for (let y = 220; y <= 740; y += 40) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 190, y }] });
      }
      await page.waitForTimeout(100);
      await feed.evaluate((node) => {
        const edge = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.getBoundingClientRect().bottom > edge + 1);
        if (row) node.setAttribute("data-reading-before", JSON.stringify({ key: row.dataset["key"], top: row.getBoundingClientRect().top }));
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    } else await page.mouse.wheel(0, -650);
    await page.locator("[data-composer][data-compact]").waitFor();
    await page.waitForTimeout(650);
    const drift = await feed.evaluate((node) => {
      const before = JSON.parse(node.getAttribute("data-reading-before")!) as { key: string; top: number };
      const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.dataset["key"] === before.key);
      return row ? Math.abs(row.getBoundingClientRect().top - before.top) : Infinity;
    });
    return drift;
  }

  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: read, compact, type, stream, latest`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(8000);
      context.on("page", (p) => p.on("pageerror", (error) => problems.push(error.message)));
      const page = await context.newPage();
      try {
        const settings = (await gw.api.getSettings({})).user!;
        await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
        await page.goto(`${base}/threads/${threadId}`);
        const composer = page.locator("[data-composer]");
        const input = composer.getByRole("textbox", { name: "Message", exact: true });
        await input.waitFor();
        await page.waitForTimeout(800);
        const expanded = (await composer.boundingBox())!.height;
        const drift = await compact(page, width === 390);
        console.info(`READING ${width} ${theme}: drift=${drift}px`);
        expect(drift).toBeLessThan(2);
        expect((await composer.boundingBox())!.height).toBeLessThan(expanded - 40);
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-compact.png`) });
        const feed = page.getByRole("region", { name: "Timeline", exact: true });
        const anchor = await feed.evaluate((node) => {
          const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1)!;
          return { key: row.dataset["key"], top: row.getBoundingClientRect().top };
        });
        gw.worker.emit(threadId, turnId, { case: "itemDelta", value: { itemId: "stream", field: ItemDeltaField.TEXT, chunk: "\n\nAnother streamed paragraph, without stealing the reader's place." } });
        await page.waitForTimeout(450);
        expect(await composer.getAttribute("data-compact")).not.toBeNull();
        const streamingDrift = await feed.evaluate((node, before) => {
          const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.dataset["key"] === before.key);
          return row ? Math.abs(row.getBoundingClientRect().top - before.top) : Infinity;
        }, anchor);
        console.info(`STREAMING ${width} ${theme}: drift=${streamingDrift}px`);
        expect(streamingDrift).toBeLessThan(2);
        // Use the visible compact row, as a person would. Locator.click may scroll a sticky
        // contenteditable to its normal-flow position before dispatching the pointer event.
        const inputBox = (await input.boundingBox())!;
        await page.mouse.click(inputBox.x + 20, inputBox.y + inputBox.height / 2);
        await page.keyboard.type("Follow up on this finding");
        await page.waitForTimeout(500);
        const focusDrift = await feed.evaluate((node, before) => {
          const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.dataset["key"] === before.key);
          return row ? Math.abs(row.getBoundingClientRect().top - before.top) : Infinity;
        }, anchor);
        console.info(`FOCUS ${width} ${theme}: drift=${focusDrift}px`);
        expect(focusDrift).toBeLessThan(2);
        expect(await composer.getAttribute("data-compact")).toBeNull();
        expect(await input.innerText()).toContain("Follow up on this finding");
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-expanded.png`) });
        // Wider steer/queue controls must reserve their own width beside the model controls.
        const send = await composer.getByRole("button", { name: "Steer into the running turn", exact: true }).boundingBox();
        const controls = await composer.locator('[aria-haspopup="dialog"]').all();
        for (const control of controls) {
          const box = await control.boundingBox();
          if (box && send && box.y >= send.y - 2 && box.y < send.y + send.height) expect(box.x + box.width).toBeLessThanOrEqual(send.x + 1);
        }
        await input.press("Control+A"); await input.press("Backspace");
        await feed.focus();
        expect(await compact(page, width === 390)).toBeGreaterThanOrEqual(0);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
        await page.waitForTimeout(650);
        expect(await composer.getAttribute("data-compact")).toBeNull();
        expect(await feed.evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThanOrEqual(8);
        await compact(page, width === 390);
        await feed.hover({ position: { x: 150, y: 150 } });
        await page.mouse.wheel(0, 10000);
        await page.waitForTimeout(700);
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await compact(page, width === 390);
        await feed.locator("article[data-key]").first().press("Control+End");
        await page.waitForTimeout(500);
        expect(await input.evaluate((n) => n === n.ownerDocument.activeElement)).toBe(true);
        expect(await composer.getAttribute("data-compact")).toBeNull();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { await context.close(); }
    }, 45000);
  }

  test("queue/subagents badge, multiline draft, file drop/paste, blocking question and reduced motion", async () => {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      try {
        await seedPanels();
        await page.goto(`${base}/threads/${threadId}`);
        const composer = page.locator("[data-composer]");
        const input = composer.getByRole("textbox", { name: "Message", exact: true });
        const feed = page.getByRole("region", { name: "Timeline", exact: true });
        await input.waitFor();
        await input.fill("Keep this first line in the compact preview.\nKeep the second line in the draft.");
        await feed.focus();
        expect(await compact(page, false)).toBeLessThan(2);
        expect(await input.evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);
        expect(await input.evaluate((n) => getComputedStyle(n).transitionDuration)).toBe("0s");
        const badge = composer.getByRole("button", { name: /Expand composer:.*agents.*queued/ });
        await badge.waitFor();
        await page.screenshot({ path: resolve(shots, `${width}-panels-compact.png`) });
        await badge.click();
        expect(await composer.getAttribute("data-compact")).toBeNull();
        expect(await input.innerText()).toContain("Keep the second line");
        await page.screenshot({ path: resolve(shots, `${width}-panels-expanded.png`) });
        await feed.focus();
        await compact(page, false);
        await composer.getByRole("group", { name: "Message, drop files to attach", exact: true }).evaluate((node) => {
          const transfer = new DataTransfer(); transfer.items.add(new File(["review"], "review.txt", { type: "text/plain" }));
          node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        });
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await feed.focus();
        await compact(page, false);
        await input.evaluate((node) => {
          const transfer = new DataTransfer(); transfer.items.add(new File(["pasted"], "pasted.txt", { type: "text/plain" }));
          node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        });
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await feed.focus();
        await compact(page, false);
        const answer = gw.worker.callTool({ threadId, turnId, tool: "ask_user", args: { wait: true, questions: [{ id: "decision", header: "Decision", question: "Which implementation should I continue with?", kind: "text" }] } });
        await page.getByText("The agent is waiting for your answers.", { exact: true }).waitFor();
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await feed.focus(); await page.mouse.wheel(0, -400); await page.waitForTimeout(150);
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await page.screenshot({ path: resolve(shots, `${width}-needs-input.png`) });
        await page.getByRole("button", { name: "Dismiss", exact: true }).click();
        await answer;
      } finally { await context.close(); }
    }
  }, 60000);

  test("panel density screenshots", async () => {
    await seedPanels();
    for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      try {
        await page.goto(`${base}/threads/${threadId}`);
        const composer = page.locator("[data-composer]");
        await composer.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        const answer = gw.worker.callTool({ threadId, turnId, tool: "ask_user", args: { wait: true, questions: [{ id: "approach", header: "Implementation", question: "Which approach should I use?", kind: "single_choice", options: [{ label: "Keep the current API", description: "Preserve existing integrations." }, { label: "Introduce a new version", description: "Allow a clean migration path." }] }] } });
        await composer.getByText("The agent is waiting for your answers.", { exact: true }).waitFor();
        await composer.getByRole("button", { name: /1 subagent/ }).click();
        await page.getByRole("region", { name: "Timeline", exact: true }).focus();
        await page.waitForTimeout(600);
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-panels-${Bun.env["OA_COMPOSER_DENSITY_PHASE"] ?? "after"}.png`) });
        await composer.getByRole("button", { name: "Dismiss", exact: true }).click();
        await answer;
      } finally { await context.close(); }
    }
  }, 45000);

  test("no browser exceptions", () => expect(problems).toEqual([]));
});
