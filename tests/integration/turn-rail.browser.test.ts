/// <reference lib="dom" />
/** Opt-in acceptance on a private Postgres/gateway/scripted worker and web port 5299.
 * OA_TURN_RAIL_BROWSER=1 bun test tests/integration/turn-rail.browser.test.ts
 * Requires the web build and /usr/bin/chromium. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ItemStatus, Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_TURN_RAIL_BROWSER"] !== "1")("conversation turn rail", () => {
  const shots = resolve(import.meta.dir, "../../artifacts/turn-rail");
  const base = "http://127.0.0.1:5299";
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser;
  let threadId: string;
  let shortId: string;
  let liveId: string;
  const problems: string[] = [];
  const message = (n: number) => `Review **turn ${n}** and its implementation.\n\n${"Explain the findings, keyboard behaviour and verification results. ".repeat(n % 5 + 1)}\n\nKeep the conversation readable while the agent works.`;

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    const projectId = (await gw.api.createProject({ name: "Turn rail acceptance" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    shortId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "One turn", initialMessage: "A short conversation" })).thread!.id;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "A long conversation", initialMessage: message(1) })).thread!.id;
    for (let n = 2; n <= 120; n++) await gw.api.sendMessage({ threadId, text: message(n), clientRequestId: crypto.randomUUID() });
    const completed = new Set<string>();
    await watchUntil(gw.api, threadId, () => completed.size === 120, (update) => {
      const turns = update.change.case === "snapshot" ? update.change.value.turns : update.change.case === "turn" ? [update.change.value] : [];
      for (const turn of turns) if (turn.status === "completed") completed.add(turn.id);
    }, 90000);
    expect(completed.size).toBe(120);
    gw.worker.holdTurns = true;
    liveId = (await gw.api.sendMessage({ threadId, text: message(121), clientRequestId: crypto.randomUUID() })).turn!.id;
    expect(await eventually(async () => gw.worker.started.has(liveId), Boolean)).toBe(true);
    gw.worker.emit(threadId, liveId, { case: "itemStarted", value: { item: { itemId: "live-answer", status: ItemStatus.IN_PROGRESS,
      content: { case: "agentMessage", value: { text: "Checking **live progress** and scrolling behaviour…", phase: "commentary" } },
    } } });
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: true } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5299", ORIGIN: base, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20000)).toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
    if (gw) { if (liveId) gw.worker.finish(threadId, liveId); await gw.close(); }
  }, 30000);

  async function theme(value: "light" | "dark") {
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: value === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
  }
  async function aligned(page: Page, id: string) {
    const result = await eventually(async () => page.evaluate((id) => {
      const feed = document.querySelector('[role="region"][aria-label="Timeline"]')!;
      const row = feed.querySelector<HTMLElement>(`article[data-key="input:${id}"]`);
      const message = row?.querySelector<HTMLElement>(".items-end");
      return { drift: row ? Math.abs(row.getBoundingClientRect().top - feed.getBoundingClientRect().top) : 100000,
        messageDrift: message ? Math.abs(message.getBoundingClientRect().top - feed.getBoundingClientRect().top) : 100000 };
    }, id), (value) => value.drift <= 2 && value.messageDrift <= 2, 6000);
    expect(result.drift).toBeLessThanOrEqual(2);
    expect(result.messageDrift).toBeLessThanOrEqual(2);
    // Remains aligned after all new measurements settle, rather than just crossing the top mid-scroll.
    await page.waitForTimeout(350);
    const drift = await page.locator(`article[data-key="input:${id}"]`).evaluate((node) => Math.abs(node.getBoundingClientRect().top - node.closest('[role="region"]')!.getBoundingClientRect().top));
    expect(drift).toBeLessThanOrEqual(2);
    console.info(`TURN ALIGN ${id}: ${drift}px`);
  }

  for (const color of ["light", "dark"] as const) {
    test(`1440px ${color}: visible range, preview, virtual jumps and keyboard`, async () => {
      await theme(color);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(error.message));
      try {
        await page.goto(`${base}/threads/${threadId}`);
        const rail = page.getByRole("navigation", { name: "Conversation turns", exact: true });
        await rail.waitFor();
        const buttons = rail.getByRole("button");
        expect(await eventually(() => buttons.count(), (n) => n === 121)).toBe(121);
        expect(await rail.locator('[data-turn-id][aria-current="location"]').count()).toBeGreaterThan(0);
        expect(await buttons.last().getAttribute("aria-current")).toBe("location");
        const feed = page.getByRole("region", { name: "Timeline", exact: true });
        const railBox = (await rail.boundingBox())!;
        const feedBox = (await feed.boundingBox())!;
        expect(railBox.x + railBox.width).toBeLessThanOrEqual(feedBox.x);
        expect(await feed.locator("article").count()).toBeLessThan(100);

        await buttons.nth(30).hover();
        const preview = page.getByRole("dialog", { name: "Turn preview", exact: true });
        await preview.waitFor();
        expect(await preview.locator("p").first().innerText()).toContain("turn 31");
        expect(await preview.locator("p").nth(1).innerText()).toContain("Echo:");
        expect(await preview.locator("strong").count()).toBeGreaterThanOrEqual(2);
        expect(await preview.locator("time").getAttribute("datetime")).not.toBe("");
        await page.screenshot({ path: resolve(shots, `1440-${color}-preview.png`) });
        // Same native popover remains open while the anchor and content move (no cold delay).
        const panel = await preview.elementHandle();
        await buttons.nth(31).hover();
        await page.waitForFunction(() => document.querySelector('[data-turn-preview]')?.textContent?.includes("turn 32"), undefined, { timeout: 250 });
        expect(await panel!.evaluate((node) => node.matches(":popover-open"))).toBe(true);

        const far = buttons.nth(7);
        const farId = (await far.getAttribute("data-turn-id"))!;
        expect(await feed.locator(`article[data-key="input:${farId}"]`).count()).toBe(0);
        await far.click();
        await aligned(page, farId);
        expect(await far.getAttribute("aria-current")).toBe("location");
        const marked = await buttons.evaluateAll((nodes) => nodes.filter((n) => n.hasAttribute("aria-current")).map((n) => n.getAttribute("data-turn-index")));
        await feed.hover({ position: { x: 250, y: 200 } });
        await page.mouse.wheel(0, 1500);
        expect(await eventually(() => buttons.evaluateAll((nodes) => nodes.filter((n) => n.hasAttribute("aria-current")).map((n) => n.getAttribute("data-turn-index"))), (now) => JSON.stringify(now) !== JSON.stringify(marked))).not.toEqual(marked);

        await far.focus();
        await page.keyboard.press("ArrowDown");
        expect(await buttons.nth(8).evaluate((node) => node === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        await aligned(page, (await buttons.nth(8).getAttribute("data-turn-id"))!);
        await page.keyboard.press("Home");
        expect(await buttons.first().evaluate((node) => node === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        await aligned(page, (await buttons.first().getAttribute("data-turn-id"))!);
        await page.keyboard.press("End");
        expect(await buttons.last().evaluate((node) => node === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        await aligned(page, liveId);
        await page.screenshot({ path: resolve(shots, `1440-${color}-last-aligned.png`) });
        await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
        expect(await eventually(() => feed.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop), (gap) => gap <= 8)).toBeLessThanOrEqual(8);
        await page.setViewportSize({ width: 1440, height: 420 });
        expect(await eventually(() => rail.locator(".t-rail-tick").count(), (n) => n < 121)).toBeLessThan(121);
        expect(await rail.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
        expect(await buttons.count()).toBe(121);
        await page.screenshot({ path: resolve(shots, `1440-${color}-compressed.png`) });
      } catch (error) {
        await page.screenshot({ path: resolve(shots, `1440-${color}-failure.png`) });
        console.info("RAIL FAILURE", await page.locator("body").innerText());
        throw error;
      } finally { await context.close(); }
    }, 45000);
  }

  for (const color of ["light", "dark"] as const) test(`390px ${color}: rail hidden and conversation fits`, async () => {
    await theme(color);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    context.setDefaultTimeout(10000);
    page.on("pageerror", (error) => problems.push(error.message));
    try {
      await page.goto(`${base}/threads/${threadId}`);
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      expect(await page.getByRole("navigation", { name: "Conversation turns", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(shots, `390-${color}.png`) });
    } catch (error) {
      console.info(`PHONE ${color} FAILURE`, await page.locator("body").innerText());
      await page.screenshot({ path: resolve(shots, `390-${color}-failure.png`) });
      throw error;
    } finally { await context.close(); }
  }, 30000);

  test("reduced motion and short conversations", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    context.setDefaultTimeout(10000);
    page.on("pageerror", (error) => problems.push(error.message));
    try {
      await page.goto(`${base}/threads/${shortId}`);
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      expect(await page.locator("[data-turn-rail]").count()).toBe(0);
      await page.goto(`${base}/threads/${threadId}`);
      const rail = page.getByRole("navigation", { name: "Conversation turns", exact: true });
      await rail.waitFor();
      expect(await rail.locator(".t-pulse").evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
      expect(await rail.locator(".t-rail-tick").first().evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
      const first = rail.getByRole("button").first();
      await first.click();
      await aligned(page, (await first.getAttribute("data-turn-id"))!);
      await page.getByRole("region", { name: "Timeline", exact: true }).focus();
      await first.focus();
      const preview = page.getByRole("dialog", { name: "Turn preview", exact: true });
      await preview.waitFor();
      expect(await preview.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
      await page.keyboard.press("Escape");
      expect(await preview.isVisible()).toBe(false);
      await page.screenshot({ path: resolve(shots, "1440-reduced-motion.png") });
    } finally { await context.close(); }
  }, 20000);

  test("no browser exceptions", () => expect(problems).toEqual([]));
});
