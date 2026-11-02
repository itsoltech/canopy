/// <reference lib="dom" />
/** Opt-in acceptance: private Postgres/gateway/scripted worker + web on 5297.
 * OA_COMPOSER_BROWSER=1 bun test tests/integration/composer-compact.browser.test.ts
 * Requires apps/web build and /usr/bin/chromium. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright-core";
import sharp from "sharp";
import { InteractionKind, ItemDeltaField, ItemStatus, Provider, TurnOutcome, ui } from "@open-agents/contracts";
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
  async function testContext(options: BrowserContextOptions) {
    const context = await browser.newContext(options);
    context.on("page", (page) => {
      page.on("pageerror", (error) => {
        const detail = `${error.message}\n${error.stack || ""}`;
        problems.push(detail);
        console.info("PAGE ERROR", detail);
      });
      page.on("requestfailed", (request) => {
        if (request.failure()?.errorText !== "net::ERR_ABORTED") console.info("REQUEST FAILED", request.url(), request.failure());
      });
      page.on("response", (response) => { if (response.status() >= 400) console.info("HTTP FAILURE", response.status(), response.url()); });
    });
    return context;
  }
  let panelsSeeded = false;
  async function seedPanels() {
    if (panelsSeeded) return;
    for (let i = 0; i < 7; i++) await gw.api.sendMessage({ threadId, text: `Queued review ${i + 1}`, clientRequestId: crypto.randomUUID() });
    await gw.worker.callTool({ threadId, turnId, tool: "spawn_thread", args: { title: "Review accessibility", prompt: "Review keyboard and mobile layout", notify: false } });
    // The latest message stays outside the live work fold; stream after the spawn call.
    gw.worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "stream", status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { text: "Working through the remaining findings…", phase: "commentary" } } } } });
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
    // Real ended turns create folded work groups, interspersed with variable-height markdown.
    for (let i = 0; i < 10; i++) {
      gw.worker.emit(threadId, turnId, { case: "itemCompleted", value: { item: {
        itemId: `command-${i}`, status: ItemStatus.COMPLETED,
        content: { case: "commandExecution", value: { command: "bun test", output: "12 pass\n0 fail", exitCode: 0 } },
      } } });
      gw.worker.finish(threadId, turnId, `### Review ${i + 1}\n\nA **markdown** result with variable height.\n\n\`\`\`ts\nconst finding = ${i};\nconsole.log(finding);\n\`\`\`\n\n- Keep the reading anchor\n- Preserve the draft`);
      await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.status === "idle");
      const previous = new Set(gw.worker.started.keys());
      await gw.api.sendMessage({ threadId, text: `Continue review ${i + 1}`, clientRequestId: crypto.randomUUID() });
      turnId = (await eventually(async () => [...gw.worker.started.keys()].find((key) => !previous.has(key)), Boolean))!;
    }
    for (let i = 0; i < 50; i++) {
      gw.worker.emit(threadId, turnId, { case: "itemCompleted", value: { item: {
        itemId: `history-${i}`, status: ItemStatus.COMPLETED,
        content: { case: "agentMessage", value: { phase: "commentary", text: `### Finding ${i + 1}\n\nThe conversation should stay **readable** while the agent works. Keep the current paragraph in place when the composer changes size.\n\n\`\`\`ts\nconst finding = ${i};\nconsole.log(finding);\n\`\`\`\n\nUse the same draft, keyboard navigation and attachment controls on every screen.` } },
      } } });
    }
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
    await feed.hover({ position: { x: 25, y: 15 } });
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

  // Unlike before/after assertions, this catches a transient jump that returns to the same
  // position at the end. Capture after the reader's scroll, before the compact layout commits.
  async function recordFrames(page: Page, afterScroll = false, waitForUpdate = false) {
    await page.getByRole("region", { name: "Timeline", exact: true }).evaluate((node, { waitForScroll, waitForUpdate }) => {
      node.removeAttribute("data-frame-result");
      node.removeAttribute("data-frame-finish");
      node.toggleAttribute("data-frame-pending", waitForUpdate);
      const start = () => {
        const edge = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.getBoundingClientRect().bottom > edge + 1)!;
        const key = row.dataset["key"];
        const baseline = row.getBoundingClientRect().top - edge;
        const frames: { drift: number; height: number; top: number; distance: number; panelOpacity: number | null }[] = [];
        const started = performance.now();
        const sample = () => {
          const same = [...node.querySelectorAll<HTMLElement>("article[data-key]")].find((r) => r.dataset["key"] === key);
          const panel = document.querySelector("[data-subagents-panel]")?.parentElement;
          frames.push({ drift: same ? same.getBoundingClientRect().top - node.getBoundingClientRect().top - baseline : Infinity,
            height: document.querySelector("[data-composer]")!.getBoundingClientRect().height,
            top: node.scrollTop, distance: node.scrollHeight - node.clientHeight - node.scrollTop,
            panelOpacity: panel ? Number(getComputedStyle(panel).opacity) : null });
          const finish = waitForUpdate ? Number(node.getAttribute("data-frame-finish") ?? Infinity) : started;
          if (performance.now() - finish < 650) requestAnimationFrame(sample);
          else node.setAttribute("data-frame-result", JSON.stringify({ key, frames, max: Math.max(...frames.map((f) => Math.abs(f.drift))) }));
        };
        sample();
      };
      if (waitForScroll) {
        let previous = node.scrollTop;
        const movedUp = () => {
          const up = previous - node.scrollTop;
          previous = node.scrollTop;
          // A stream may pin the end between installing this listener and the input gesture.
          // Start only on the deliberate upward gesture, never that programmatic scroll.
          if (up < 96) return;
          node.removeEventListener("scroll", movedUp);
          start();
        };
        node.addEventListener("scroll", movedUp);
      } else start();
    }, { waitForScroll: afterScroll, waitForUpdate });
  }

  async function frameResult(page: Page, label: string) {
    const feed = page.getByRole("region", { name: "Timeline", exact: true });
    // Gateway delivery can take longer than an animation under load. Keep the baseline and
    // every frame from before the update until 650ms after its observed state arrives.
    await feed.evaluate((node) => { if (node.hasAttribute("data-frame-pending")) node.setAttribute("data-frame-finish", String(performance.now())); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Timeline"][role="region"]')?.hasAttribute("data-frame-result"));
    const result = JSON.parse((await feed.getAttribute("data-frame-result"))!) as { key: string; max: number; frames: { drift: number; height: number; top: number; distance: number; panelOpacity: number | null }[] };
    writeFileSync(resolve(shots, `${label}-frames.json`), JSON.stringify(result, null, 2));
    console.info(`FRAMES ${label}: ${result.frames.length} samples, max=${result.max}px`);
    expect(result.frames.length).toBeGreaterThan(5);
    expect(result.frames.every((f) => Number.isFinite(f.drift))).toBe(true);
    return result;
  }

  async function expectTopOutline(page: Page) {
    const panel = page.locator("[data-composer-panels]");
    const box = (await panel.boundingBox())!;
    expect(box.y).toBeGreaterThan(2);
    const pixels = await sharp(await page.screenshot()).extract({ left: Math.floor(box.x + box.width / 2), top: Math.floor(box.y) - 2, width: 1, height: 4 }).removeAlpha().raw().toBuffer();
    const reds = [pixels[0]!, pixels[3]!, pixels[6]!, pixels[9]!];
    // A computed ring alone passed the old clipped layout. Assert actual pixels across
    // the top edge, away from text/icons, in both color schemes.
    expect(Math.max(...reds) - Math.min(...reds)).toBeGreaterThan(5);
  }

  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) test(`${width}px ${theme}: every animation frame, focused draft, threshold and streaming`, async () => {
    await seedPanels();
    const context = await testContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    try {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
      await page.goto(`${base}/threads/${threadId}`);
      const composer = page.locator("[data-composer]");
      const input = composer.getByRole("textbox", { name: "Message", exact: true });
      const feed = page.getByRole("region", { name: "Timeline", exact: true });
      for (const streaming of [false, true]) {
        const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
        if (await latest.isVisible()) await latest.click();
        await input.fill("A draft that keeps its focus\n".repeat(20));
        await page.waitForTimeout(700);
        await feed.hover({ position: { x: 150, y: 30 } });
        const label = `${width}-${theme}-${streaming ? "streaming" : "idle"}`;
        let timer: ReturnType<typeof setInterval> | undefined;
        const session = width === 390 ? await context.newCDPSession(page) : undefined;
        try {
          if (streaming) timer = setInterval(() => gw.worker.emit(threadId, turnId, { case: "itemDelta", value: { itemId: "stream", field: ItemDeltaField.TEXT, chunk: "\n\nStreaming while the composer changes height." } }), 45);
          await recordFrames(page, true);
          if (session) {
            // One native touch movement, held still through the animation: no additional
            // intentional scroll is mixed into the drift samples, and no fling on release.
            const box = (await feed.boundingBox())!;
            await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 170, y: box.y + 15 }] });
            await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 170, y: box.y + 235 }] });
          } else await page.mouse.wheel(0, -205);
          const shrink = await frameResult(page, `${label}-shrink`);
          if (session) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          expect(await composer.getAttribute("data-compact")).not.toBeNull();
          expect(shrink.max).toBeLessThanOrEqual(1);
          expect(await input.evaluate((n) => n === document.activeElement)).toBe(true);
          expect((await shrink.frames.at(-1)!.height)).toBeLessThan(shrink.frames[0]!.height - 40);
          await page.screenshot({ path: resolve(shots, `${label}-compact.png`) });
          await recordFrames(page);
          await page.keyboard.type("!");
          const grow = await frameResult(page, `${label}-grow`);
          expect(await composer.getAttribute("data-compact")).toBeNull();
          expect(grow.max).toBeLessThanOrEqual(1);
          expect(await input.innerText()).toContain("A draft that keeps its focus");
          expect(grow.frames.at(-1)!.height).toBeGreaterThan(grow.frames[0]!.height + 40);
          await page.screenshot({ path: resolve(shots, `${label}-expanded.png`) });
        } finally { if (timer) clearInterval(timer); await session?.detach(); }
      }
      // Rapid reversals around the far threshold cannot unfold a compact composer. Only
      // reaching the near/end threshold or another explicit editor action can do that.
      await compact(page, false);
      await feed.hover({ position: { x: 25, y: 15 } });
      await feed.evaluate((node) => {
        const composer = document.querySelector("[data-composer]")!;
        let changes = 0;
        new MutationObserver(() => { node.setAttribute("data-compact-changes", String(++changes)); }).observe(composer, { attributes: true, attributeFilter: ["data-compact"] });
        node.setAttribute("data-compact-changes", "0");
        node.scrollTop = node.scrollHeight - node.clientHeight - 195;
      });
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -25); await page.mouse.wheel(0, 25); }
      await page.waitForTimeout(450);
      expect(await composer.getAttribute("data-compact")).not.toBeNull();
      expect(await feed.getAttribute("data-compact-changes")).toBe("0");

      // Also exercise a window that actually mounts ended turns and their folded work,
      // rather than leaving those rows somewhere offscreen in the fixture.
      await input.fill("Read the folded work");
      await feed.evaluate((node) => { node.scrollTop = 600; });
      await page.waitForTimeout(450);
      expect(await composer.getAttribute("data-compact")).toBeNull(); // programmatic scroll
      expect(await feed.getByRole("button", { name: /^Work/ }).count()).toBeGreaterThan(0);
      await feed.hover({ position: { x: 25, y: 15 } });
      await recordFrames(page, true);
      await page.mouse.wheel(0, -120);
      expect((await frameResult(page, `${width}-${theme}-folded-shrink`)).max).toBeLessThanOrEqual(1);
      await recordFrames(page);
      await page.keyboard.type("!");
      expect((await frameResult(page, `${width}-${theme}-folded-grow`)).max).toBeLessThanOrEqual(1);
      if (width === 390) {
        // The mobile suggestions branch uses the unchanged MentionEditor/ComposerBox slot.
        await input.fill("");
        await input.pressSequentially("/");
        const suggestions = composer.locator("[data-mention-inline]");
        await suggestions.waitFor();
        await page.waitForTimeout(300);
        const panelBox = (await suggestions.boundingBox())!;
        const editorBox = (await input.boundingBox())!;
        expect(panelBox.y).toBeGreaterThanOrEqual(0);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(editorBox.y + 1);
        expect(await input.evaluate((node) => node === document.activeElement)).toBe(true);
        await input.press("Escape");
        await suggestions.waitFor({ state: "hidden" });
      }
    } catch (error) {
      console.info("BROWSER FAILURE", await page.locator("body").innerText());
      await page.screenshot({ path: resolve(shots, `${width}-${theme}-frames-failure.png`) });
      throw error;
    } finally { await context.close(); }
  }, 35000);

  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: read, compact, type, stream, latest`, async () => {
      const context = await testContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(8000);
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
      } catch (error) {
        console.info("BROWSER FAILURE", await page.locator("body").innerText());
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-failure.png`) });
        throw error;
      } finally { await context.close(); }
    }, 45000);
  }

  test("visible queue/subagent summaries, multiline draft, files, blocking question and reduced motion", async () => {
    for (const width of [1440, 390]) {
      const context = await testContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
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
        const agents = composer.getByRole("button", { name: /1 subagent/ });
        await agents.waitFor();
        expect(await agents.isVisible()).toBe(true);
        expect(await composer.getByRole("button", { name: "7 queued", exact: true }).isVisible()).toBe(true);
        expect(await composer.getByRole("button", { name: /Expand composer:/ }).count()).toBe(0);
        await composer.getByRole("button", { name: "7 queued", exact: true }).click();
        expect(await composer.getAttribute("data-compact")).toBeNull();
        expect(await composer.getByText("Queued review 1", { exact: true }).isVisible()).toBe(true);
        await feed.focus();
        await compact(page, false);
        await page.screenshot({ path: resolve(shots, `${width}-panels-compact.png`) });
        await agents.click();
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

        await gw.worker.callTool({ threadId, turnId, tool: "ask_user", args: { wait: false, questions: [{ id: "async-review", header: "Async review", question: "Any further feedback?", kind: "text" }] } });
        await composer.getByRole("button", { name: "Send a message", exact: true }).click();
        await compact(page, false);
        expect(await composer.getByRole("button", { name: /Async review/ }).isVisible()).toBe(true);
        const summary = composer.getByRole("button", { name: /Async review/ });
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        const body = page.locator(`[id="${await summary.getAttribute("aria-controls")}"]`);
        expect((await body.boundingBox())!.height).toBe(0);
        expect(await body.getAttribute("inert")).not.toBeNull();
        await composer.getByRole("button", { name: /Async review/ }).click();
        expect(await composer.getAttribute("data-compact")).toBeNull();
        await composer.getByRole("button", { name: "Skip all", exact: true }).click();
        await composer.getByRole("button", { name: /Async review/ }).waitFor({ state: "detached" });
      } finally { await context.close(); }
    }
  }, 60000);

  test("panel density screenshots", async () => {
    await seedPanels();
    for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
      const context = await testContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      page.on("requestfailed", (request) => console.info("DENSITY REQUEST ERROR", request.url(), request.failure()?.errorText));
      try {
        await page.goto(`${base}/threads/${threadId}`);
        const composer = page.locator("[data-composer]");
        await composer.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        const answer = gw.worker.callTool({ threadId, turnId, tool: "ask_user", args: { wait: true, questions: [{ id: "approach", header: "Implementation", question: "Which approach should I use?", kind: "single_choice", options: [{ label: "Keep the current API", description: "Preserve existing integrations." }, { label: "Introduce a new version", description: "Allow a clean migration path." }] }] } });
        await composer.getByText("The agent is waiting for your answers.", { exact: true }).waitFor();
        await composer.getByRole("button", { name: /1 subagent/ }).click();
        const queued = composer.getByRole("button", { name: "7 queued", exact: true });
        if (await queued.getAttribute("aria-expanded") === "true") await queued.click();
        await page.getByRole("region", { name: "Timeline", exact: true }).focus();
        await page.waitForTimeout(600);
        await expectTopOutline(page);
        if (Bun.env["OA_COMPOSER_DENSITY_PHASE"] !== "before") {
          const header = composer.getByRole("button", { name: /1 subagent/ });
          expect((await header.boundingBox())!.height).toBeLessThanOrEqual(36);
          expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(32);
          expect((await composer.getByRole("link", { name: /Review accessibility/ }).boundingBox())!.height).toBeLessThanOrEqual(40);
          expect(await header.locator("svg").last().evaluate((n) => n.getBoundingClientRect().width)).toBe(12);
          if (width === 390) {
            const targets = await composer.locator('span[class*="pointer-fine:hidden"]').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => Math.min(r.width, r.height)));
            expect(Math.min(...targets)).toBeGreaterThanOrEqual(40);
          }
        }
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-panels-${Bun.env["OA_COMPOSER_DENSITY_PHASE"] ?? "after"}.png`) });
        await composer.getByRole("button", { name: "Dismiss", exact: true }).click();
        await answer;
        await composer.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      } catch (error) {
        console.info("DENSITY FAILURE", await page.locator("body").innerText());
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-density-failure.png`) });
        throw error;
      } finally { await context.close(); }
    }
  }, 45000);

  test("active subagents only: needs input, row exits and last-panel removal preserve every reading frame", async () => {
    const original = (await gw.api.getThread({ threadId })).thread!;
    const parent = (await gw.api.createThread({ projectId: original.projectId, workspaceId: original.workspaceId, provider: Provider.CODEX,
      title: "Active subagents", initialMessage: "Review active work" })).thread!;
    async function runningTurn(id: string) {
      const command = (await eventually(async () => gw.worker.commands.find((c) => c.case === "startTurn" && c.value.thread?.threadId === id), Boolean))!;
      if (command.case !== "startTurn") throw new Error("Missing scripted turn");
      return command.value.turnId;
    }
    let parentTurn = await runningTurn(parent.id);
    // Ended answers remain visible with the live-work folding introduced on main.
    for (let i = 0; i < 12; i++) {
      gw.worker.finish(parent.id, parentTurn, `### Review ${i}\n\nKeep this **markdown** paragraph in place while active work arrives and leaves.\n\n\`\`\`ts\nconst review = ${i};\nconsole.log(review);\n\`\`\`\n\n- Preserve the reading position\n- Keep the draft`);
      await eventually(() => gw.api.getThread({ threadId: parent.id }), (r) => r.thread?.status === "idle");
      const previous = new Set(gw.worker.started.keys());
      await gw.api.sendMessage({ threadId: parent.id, text: `Continue active review ${i}`, clientRequestId: crypto.randomUUID() });
      parentTurn = (await eventually(async () => [...gw.worker.started.keys()].find((key) => !previous.has(key)), Boolean))!;
    }
    async function spawn(title: string) {
      const result = await gw.worker.callTool({ threadId: parent.id, turnId: parentTurn, tool: "spawn_thread", args: { title, prompt: title, notify: false, interactions: "human" } });
      if (result.isError) throw new Error(result.content);
      const id = (JSON.parse(result.content) as { thread_id: string }).thread_id;
      return { id, turn: await runningTurn(id), title };
    }
    for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
      const context = await testContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      try {
        await page.goto(`${base}/threads/${parent.id}`);
        const composer = page.locator("[data-composer]");
        const input = composer.getByRole("textbox", { name: "Message", exact: true });
        const feed = page.getByRole("region", { name: "Timeline", exact: true });
        const panel = composer.locator("[data-subagents-panel]");
        await input.fill("Keep the reader here");
        await page.waitForTimeout(700);
        expect(await panel.count()).toBe(0);
        await compact(page, false);
        await recordFrames(page, false, true);
        const a = await spawn(`${width}-${theme} completed review`);
        await panel.getByRole("button", { name: /1 subagent working/ }).waitFor();
        expect(await panel.evaluate((node) => {
          const style = getComputedStyle(node.parentElement!);
          return { name: style.animationName, duration: style.animationDuration };
        })).toEqual({ name: "t-rise", duration: "0.25s" });
        const appear = await frameResult(page, `${width}-${theme}-active-appear`);
        expect(appear.max).toBeLessThanOrEqual(1);
        expect(appear.frames.some((f) => f.panelOpacity !== null && f.panelOpacity > 0 && f.panelOpacity < 1)).toBe(true);
        expect(await composer.getAttribute("data-compact")).not.toBeNull();
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-active-compact.png`) });
        const b = await spawn(`${width}-${theme} approval review`);
        const c = await spawn(`${width}-${theme} failed review`);
        const permission = Bun.randomUUIDv7();
        gw.worker.ask({ requestId: permission, threadId: b.id, turnId: b.turn, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: '{"command":"bun test"}' });
        await panel.getByRole("button", { name: /2 subagents working · 1 needs you/ }).waitFor();
        // Expand the same list, then measure a completed row leaving while others stay.
        await input.fill("Read active rows");
        await panel.getByRole("button", { name: /2 subagents working · 1 needs you/ }).click();
        await page.waitForTimeout(300);
        expect(await panel.locator("[data-subagent-row]").count()).toBe(3);
        await recordFrames(page, false, true);
        gw.worker.finish(a.id, a.turn);
        await panel.getByRole("button", { name: /1 subagent working · 1 needs you/ }).waitFor();
        const exit = await frameResult(page, `${width}-${theme}-active-row-exit`);
        expect(exit.max).toBeLessThanOrEqual(1);
        expect(new Set(exit.frames.map((f) => f.height)).size).toBeGreaterThan(2);
        expect(await panel.getByRole("link", { name: new RegExp(a.title) }).count()).toBe(0);
        await gw.api.answerInteraction({ requestId: permission, allow: true });
        await panel.getByRole("button", { name: /2 subagents working/ }).waitFor();
        gw.worker.emit(c.id, c.turn, { case: "turnFinished", value: { outcome: TurnOutcome.FAILED } });
        await panel.getByRole("button", { name: /1 subagent working/ }).waitFor();
        await page.waitForTimeout(200);
        expect(await panel.getByRole("link", { name: new RegExp(c.title) }).count()).toBe(0);
        await compact(page, false);
        await recordFrames(page, false, true);
        gw.worker.emit(b.id, b.turn, { case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED } });
        await panel.waitFor({ state: "detached" });
        const gone = await frameResult(page, `${width}-${theme}-active-disappear`);
        expect(gone.max).toBeLessThanOrEqual(1);
        expect(new Set(gone.frames.map((f) => f.height)).size).toBeGreaterThan(2);
        expect(await composer.locator("[data-composer-panels]").count()).toBe(0);
        expect(await composer.getAttribute("data-compact")).not.toBeNull();
        await page.screenshot({ path: resolve(shots, `${width}-${theme}-active-none.png`) });
        await input.fill("No active agents remain");
        expect(await panel.count()).toBe(0); // same rule in expanded state
        const closed = await spawn(`${width}-${theme} closed review`);
        await panel.getByRole("button", { name: /1 subagent working/ }).waitFor();
        await recordFrames(page, false, true);
        await gw.worker.callTool({ threadId: parent.id, turnId: parentTurn, tool: "close_thread", args: { thread_id: closed.id } });
        await panel.waitFor({ state: "detached" });
        expect((await frameResult(page, `${width}-${theme}-active-close`)).max).toBeLessThanOrEqual(1);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const reduced = await spawn(`${width}-${theme} reduced motion`);
        await panel.getByRole("button", { name: /1 subagent working/ }).waitFor();
        expect(await panel.evaluate((node) => getComputedStyle(node.parentElement!).animationName)).toBe("none");
        await recordFrames(page, false, true);
        gw.worker.finish(reduced.id, reduced.turn);
        await panel.waitFor({ state: "detached" });
        const instant = await frameResult(page, `${width}-${theme}-active-reduced`);
        expect(instant.max).toBeLessThanOrEqual(1);
        // No intermediate heights: reduced motion removes the panel in one layout update.
        expect(new Set(instant.frames.map((f) => f.height)).size).toBeLessThanOrEqual(2);
        // Release the agent-bus open-thread quota between viewport/theme variants.
        for (const agent of [a, b, c, reduced]) await gw.worker.callTool({ threadId: parent.id, turnId: parentTurn, tool: "close_thread", args: { thread_id: agent.id } });
      } finally { await context.close(); }
    }
  }, 90000);

  test("no browser exceptions", () => expect(problems).toEqual([]));
});
