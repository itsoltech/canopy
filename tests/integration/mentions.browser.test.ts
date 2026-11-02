/// <reference lib="dom" />
/** Isolated acceptance stack; never uses the shared development stack.
 * OA_MENTION_BROWSER=1 bun test tests/integration/mentions.browser.test.ts
 * Build apps/web first. Optional OA_MENTION_WEBKIT_WS connects to Playwright's run-server
 * in mcr.microsoft.com/playwright:v1.64.1-noble (same playwright-core version).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, devices, webkit, type Browser, type Locator, type Page } from "playwright-core";
import { ItemStatus, MentionKind, Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_MENTION_BROWSER"] !== "1")("composer suggestions", () => {
  const base = "http://127.0.0.1:5299";
  const shots = resolve(import.meta.dir, "../../artifacts/mentions-mobile");
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let threadId: string;
  let turnId: string;
  const browsers = new Map<string, Browser>();
  const problems: string[] = [];

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    gw.worker.handlers.set("listMentionCatalog", (_value, reply) => reply(true, { mentionCatalog: {
      provider: Provider.CODEX, profileId: "native", cwd: "/repo", entries: [
        ...Array.from({ length: 32 }, (_, i) => ({ kind: MentionKind.COMMAND, name: `review-${i}`, description: `Review section ${i}`, source: "harness" })),
        { kind: MentionKind.SKILL, name: "polish-review", label: "Polish review", source: "system", path: "/skills/polish-review/SKILL.md" },
      ],
    } }));
    gw.worker.handlers.set("searchFiles", (_value, reply) => reply(true, { fileSearch: {
      matches: Array.from({ length: 32 }, (_, i) => ({ path: `docs/notatka-${i}.md`, indices: [] })), source: "git",
    } }));
    const projectId = (await gw.api.createProject({ name: "Mobile mentions" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Plan przeglądu" });
    gw.worker.holdTurns = true;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Composer acceptance", initialMessage: "Review" })).thread!.id;
    turnId = (await eventually(async () => [...gw.worker.started.keys()][0], Boolean))!;
    for (let i = 0; i < 35; i++) gw.worker.emit(threadId, turnId, { case: "itemCompleted", value: { item: {
      itemId: `history-${i}`, status: ItemStatus.COMPLETED,
      content: { case: "agentMessage", value: { phase: "commentary", text: `Finding ${i}: keep the draft and editor focus while reading this conversation.\n\nA second paragraph to create scrollable history.` } },
    } } });
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: true } });
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5299", ORIGIN: base, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20000)).toBe(true);
    browsers.set("chromium", await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] }));
    if (Bun.env["OA_MENTION_WEBKIT_WS"]) browsers.set("webkit", await webkit.connect(Bun.env["OA_MENTION_WEBKIT_WS"]!));
    else if (Bun.env["OA_MENTION_WEBKIT"] === "1") browsers.set("webkit", await webkit.launch());
  }, 60000);

  afterAll(async () => {
    for (const browser of browsers.values()) await browser.close();
    web?.kill();
    if (web) await web.exited;
    if (gw) { if (turnId) gw.worker.finish(threadId, turnId); await gw.close(); }
  }, 30000);

  async function withPage(engine: string, width: number, theme: "light" | "dark", run: (page: Page, input: Locator) => Promise<void>) {
    const browser = browsers.get(engine);
    if (!browser) throw new Error(`${engine} was not started`);
    const context = await browser.newContext(width === 390 ? { ...devices["iPhone 13"], viewport: { width, height: 844 }, colorScheme: theme } : { viewport: { width, height: 1000 }, colorScheme: theme });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const input = page.locator("[data-composer]").getByRole("textbox", { name: "Message", exact: true });
    const pending = new Set<string>();
    page.on("request", (request) => pending.add(request.url()));
    page.on("requestfinished", (request) => pending.delete(request.url()));
    page.on("requestfailed", (request) => {
      pending.delete(request.url());
      if (request.url().includes("/_app/")) console.error("STATIC REQUEST FAILED", request.url(), request.failure()?.errorText);
    });
    page.on("pageerror", (error) => problems.push(error.message));
    try {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
      await page.goto(`${base}/threads/${threadId}`);
      await input.waitFor();
      await input.fill("");
      await run(page, input);
    } catch (error) {
      console.info("FAILURE EDITOR", await input.innerHTML().catch(() => "unavailable"));
      console.info("PENDING REQUESTS", [...pending]);
      await page.screenshot({ path: resolve(shots, `${engine}-${width}-${theme}-failure.png`) });
      throw error;
    } finally { await context.close(); }
  }

  const engines = ["chromium", ...(Bun.env["OA_MENTION_WEBKIT_WS"] || Bun.env["OA_MENTION_WEBKIT"] === "1" ? ["webkit"] : [])];
  for (const engine of engines) {
    test(`${engine}: composition input detects a trigger before compositionend`, async () => {
      await withPage(engine, 390, "light", async (page, input) => {
        await input.focus();
        await input.evaluate((node) => {
          node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          const text = document.createTextNode("$"); node.replaceChildren(text);
          const range = document.createRange(); range.setStart(text, 1); range.collapse(true);
          getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
          node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "$", isComposing: true }));
        });
        await page.getByRole("listbox", { name: "Skills and plugins" }).waitFor();
        expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
        await page.screenshot({ path: resolve(shots, `${engine}-composition.png`) });
        // No compositionend: a committed replacement must also recover sending/navigation.
        await input.dispatchEvent("input", { inputType: "insertReplacementText", data: "$", isComposing: false });
        await input.press("Escape");
        await page.getByRole("listbox", { name: "Skills and plugins" }).waitFor({ state: "hidden" });
      });
    }, 30000);

    for (const theme of ["light", "dark"] as const) for (const width of [390, 1440]) {
      test(`${engine}: ${width}px ${theme} triggers, selection and scroll`, async () => {
        await withPage(engine, width, theme, async (page, input) => {
          for (const [char, label] of [["/", "Commands"], ["$", "Skills and plugins"], ["@", "Files"], ["#", "Threads"]] as const) {
            await input.fill("");
            expect(await input.locator('[data-element="mention"]').count()).toBe(0);
            await input.pressSequentially(char);
            const list = page.getByRole("listbox", { name: label, exact: true });
            await list.getByRole("option").first().waitFor();
            const panel = width === 390 ? page.locator("[data-mention-inline]") : page.locator('[popover="manual"]:popover-open').filter({ has: list });
            await panel.waitFor();
            // Panel reveal changes its flow height; desktop positioning also follows async
            // catalog results. Assert settled geometry rather than the first animation frame.
            expect(await eventually(async () => {
              const p = await panel.boundingBox(); const e = await input.boundingBox();
              return Boolean(p && e && p.y >= 0 && p.y + p.height <= e.y + 1);
            }, Boolean)).toBe(true);
            const bounds = (await panel.boundingBox())!;
            expect(bounds.y).toBeGreaterThanOrEqual(0);
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            if (width === 390) {
              expect(await list.evaluate((node) => node.closest("[popover]") === null)).toBe(true);
              expect(bounds.height).toBeLessThanOrEqual(844 * 0.4 + 1);
            } else expect(await page.locator("[data-mention-inline]").count()).toBe(0);
            await page.screenshot({ path: resolve(shots, `${engine}-${width}-${theme}-${label.split(" ")[0]}.png`) });
            if (char === "/" || char === "@") {
              const scroll = width === 390 ? panel.locator("[data-mention-scroll]") : panel;
              // Chromium supports a real touch scroll through CDP. Mobile WebKit's
              // Playwright API has no wheel/swipe, so it checks overflow via scrollBy.
              if (engine === "webkit" && width === 390) await scroll.evaluate((node) => node.scrollBy(0, 240));
              else if (width === 390) {
                const box = (await scroll.boundingBox())!;
                const session = await page.context().newCDPSession(page);
                const x = box.x + box.width / 2;
                const start = box.y + box.height - 20;
                try {
                  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
                  for (let dy = 20; dy <= 180; dy += 20) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: start - dy }] });
                  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                }
                finally { await session.detach(); }
              }
              else { await scroll.hover(); await page.mouse.wheel(0, 240); }
              expect(await eventually(() => scroll.evaluate((node) => node.scrollTop), (top) => top > 0)).toBeGreaterThan(0);
              expect(await input.locator('[data-element="mention"]').count()).toBe(0);
              expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
            }
            const option = list.getByRole("option").first();
            await option.scrollIntoViewIfNeeded();
            if (width === 390) await option.tap(); else await option.click();
            expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
            expect(await input.locator('[data-element="mention"]').count()).toBe(1);
            expect(await input.locator('[data-element="mention"]').getAttribute("contenteditable")).toBe("false");
            await list.waitFor({ state: "hidden" });
            // Delete as a person does: the trailing space, then the atomic chip. WebKit's
            // contenteditable fill("") can leave an empty non-editable span behind.
            await input.press("Backspace"); await input.press("Backspace");
            expect(await input.locator('[data-element="mention"]').count()).toBe(0);
          }
          await input.fill("$does-not-exist");
          await page.getByText("No skills or plugins match", { exact: true }).waitFor();
          await input.press("Escape");
          await input.fill("/review");
          await page.getByRole("option").first().waitFor();
          await input.press("ArrowDown"); await input.press("Enter");
          expect(await input.locator('[data-element="mention"]').count()).toBe(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
      }, 60000);
    }

    test(`${engine}: compact focus keeps the same editor and visual viewport caps the panel`, async () => {
      await withPage(engine, 390, "dark", async (page, input) => {
        await input.evaluate((node) => node.setAttribute("data-original-editor", "true"));
        const feed = page.getByRole("region", { name: "Timeline", exact: true });
        await eventually(() => feed.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop), (gap) => gap <= 8);
        await feed.focus();
        if (engine === "webkit") await feed.evaluate((node) => {
          node.dispatchEvent(new Event("touchmove", { bubbles: true }));
          node.scrollBy(0, -1000);
        });
        else { await feed.hover(); await page.mouse.wheel(0, -1000); }
        await page.locator("[data-composer][data-compact]").waitFor();
        await input.tap();
        await input.pressSequentially("/");
        await page.getByRole("option").first().waitFor();
        expect(await input.getAttribute("data-original-editor")).toBe("true");
        expect(await page.locator("[data-composer]").getAttribute("data-compact")).toBeNull();
        // Playwright has no native iOS keyboard. Simulate visualViewport resize + offset,
        // leaving layout viewport unchanged, to verify our cap/listener instead.
        await page.evaluate(() => {
          Object.defineProperty(visualViewport!, "height", { configurable: true, value: 360 });
          Object.defineProperty(visualViewport!, "offsetTop", { configurable: true, value: 120 });
          visualViewport!.dispatchEvent(new Event("resize")); visualViewport!.dispatchEvent(new Event("scroll"));
        });
        const panel = page.locator("[data-mention-inline]");
        expect(await eventually(() => panel.evaluate((node) => node.getBoundingClientRect().height), (height) => height <= 145)).toBeLessThanOrEqual(145);
        expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
        await page.screenshot({ path: resolve(shots, `${engine}-visual-viewport.png`) });
        await feed.focus();
        await page.getByRole("listbox", { name: "Commands", exact: true }).waitFor({ state: "hidden" });
      });
    }, 30000);
  }
  test("no browser exceptions", () => expect(problems).toEqual([]));
});
