/// <reference lib="dom" />
/** OA_TIMELINE_BROWSER=1 bun test tests/integration/timeline-folding.browser.test.ts
 * Private throwaway PostgreSQL/gateway/worker and built web on 5398. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { chromium, type Browser, type Page } from "playwright-core";
import { ItemDeltaField, ItemSchema, ItemStatus, Provider, ui } from "@open-agents/contracts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_TIMELINE_BROWSER"] !== "1")("timeline folding browser", () => {
  const shots = resolve(import.meta.dir, "../../artifacts/timeline-folding");
  const base = "http://127.0.0.1:5398";
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser;
  let projectId: string;
  let workspaceId: string;
  const problems: string[] = [];

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    gw.worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "Timeline acceptance" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5398", ORIGIN: base, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(() => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20000)).toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
    if (gw) await gw.close();
  }, 30000);

  async function newTurn(page: Page) {
    const seen = new Set(gw.worker.started.keys());
    const threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Folded work, readable answers", initialMessage: "Review the timeline and explain the findings." })).thread!.id;
    const turnId = (await eventually(async () => [...gw.worker.started.keys()].find((id) => !seen.has(id)), Boolean))!;
    const emit = (item: MessageInitShape<typeof ItemSchema>, started = false) => gw.worker.emit(threadId, turnId, { case: started ? "itemStarted" : "itemCompleted", value: { item } });
    await page.goto(`${base}/threads/${threadId}`);
    await page.getByRole("button", { name: /Working for/ }).waitFor();
    return { threadId, turnId, emit };
  }

  const longAnswer = "## Final answer starts here\n\n" + Array.from({ length: 28 }, (_, i) => `### Finding ${i + 1}\n\nThe timeline keeps the work folded while the answer remains readable. This paragraph exercises the reading position, height measurements and streaming at both viewport sizes.\n\n`).join("");
  const region = (page: Page) => page.getByRole("region", { name: "Timeline", exact: true });
  async function showFold(page: Page) {
    await region(page).focus();
    await region(page).press("Home");
    await eventually(() => region(page).evaluate((node) => node.scrollTop), (top) => top < 2);
    await page.getByRole("button", { name: /Working for/ }).waitFor();
  }
  async function latest(page: Page) {
    const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
    if (await jump.count()) await jump.click();
    expect(await eventually(() => region(page).evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight), (gap) => gap < 2)).toBeLessThan(2);
  }

  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`${width}px ${theme}: live groups, state memory, handoff, finish and reading position`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
      context.setDefaultTimeout(10000);
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(error.message));
      const prefix = `${width}-${theme}`;
      try {
        const settings = (await gw.api.getSettings({})).user!;
        await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, threadPanelCollapsed: true, colorScheme: theme === "dark" ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } });
        const { threadId, turnId, emit } = await newTurn(page);
        const fold = page.getByRole("button", { name: /Working for/ });
        expect(await fold.getAttribute("aria-expanded")).toBe("false");
        const initialLabel = await fold.innerText();
        expect(await eventually(() => fold.innerText(), (text) => text !== initialLabel, 4000)).not.toBe(initialLabel);

        for (let i = 0; i < 32; i++) {
          emit({ itemId: `read-${i}`, status: ItemStatus.COMPLETED, content: { case: "toolCall", value: { name: "Read", inputJson: `{"file_path":"/repo/src/file-${i}.ts"}`, output: "1\tconst result = true;" } } });
          for (let c = 0; c < 5; c++) emit({ itemId: `cmd-${i}-${c}`, status: c === 4 ? ItemStatus.FAILED : ItemStatus.COMPLETED, content: { case: "commandExecution", value: { command: `bun test suite-${i}-${c}`, exitCode: c === 4 ? 1 : 0, output: "TOOL OUTPUT SHOULD START HIDDEN\n".repeat(12) } } });
          emit({ itemId: `progress-${i}`, status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { phase: "commentary", text: `Progress update ${i + 1}: checked the next group and continuing with the review.` } } });
        }
        emit({ itemId: "mcp", status: ItemStatus.FAILED, content: { case: "toolCall", value: { server: "github", name: "get_issue", inputJson: '{"title":"Timeline issue"}', output: "MCP RESULT SHOULD START HIDDEN", isError: true } } });
        emit({ itemId: "edit", status: ItemStatus.COMPLETED, content: { case: "fileChange", value: { changes: [{ path: "/repo/app.ts", kind: "update", diff: "--- app.ts\n+++ app.ts\n-old\n+new\n+extra" }] } } });
        emit({ itemId: "bus", status: ItemStatus.COMPLETED, content: { case: "agentBusCall", value: { toolName: "list_threads", argumentsJson: "{}", resultJson: '{"threads":[]}' } } });
        emit({ itemId: "active", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution", value: { command: "bun test live-check", output: "RUNNING OUTPUT SHOULD START HIDDEN" } } }, true);
        await page.getByRole("button", { name: /Working for.*Running bun test live-check/ }).waitFor();
        expect(await region(page).locator("[data-quote-item]").count()).toBeLessThan(3);
        await page.screenshot({ path: resolve(shots, `${prefix}-live-collapsed.png`) });

        await fold.click();
        // The newest tool group is mounted near the end even in a very long turn.
        const lastGroup = page.locator('article[data-key^="group:"]').last().getByRole("button");
        expect(await lastGroup.getAttribute("aria-expanded")).toBe("false");
        await lastGroup.click();
        await page.locator('[data-quote-item="active"] summary').waitFor();
        for (const id of ["active", "mcp", "bus", "edit"]) {
          const details = page.locator(`[data-quote-item="${id}"] details`).first();
          expect(await details.getAttribute("open")).toBeNull();
        }
        expect(await page.locator('[data-quote-item="edit"] summary').innerText()).toContain("+2");
        expect(await page.locator('[data-quote-item="edit"] summary').innerText()).toContain("−1");
        expect(await page.getByText("RUNNING OUTPUT SHOULD START HIDDEN", { exact: true }).count()).toBe(0);
        expect(await page.getByText("MCP RESULT SHOULD START HIDDEN", { exact: true }).count()).toBe(0);
        await page.locator('[data-quote-item="active"] summary').click();
        await page.getByText("RUNNING OUTPUT SHOULD START HIDDEN", { exact: true }).waitFor();
        await showFold(page);
        await fold.click();
        await fold.click();
        await latest(page);
        await page.getByText("RUNNING OUTPUT SHOULD START HIDDEN", { exact: true }).waitFor();
        await page.locator('[data-quote-item="active"] summary').click();
        await showFold(page);
        await page.screenshot({ path: resolve(shots, `${prefix}-live-expanded.png`) });
        await latest(page);
        expect(await region(page).locator("article[data-key]").count()).toBeLessThan(80);
        // A failed command remains closed even when the group opens.
        const commandGroup = page.locator('article[data-key^="group:"]').filter({ hasText: "Read 1 file and ran 5 commands" }).last().getByRole("button");
        await commandGroup.click();
        const failed = page.locator('[data-quote-item="cmd-31-4"]');
        await failed.waitFor();
        expect(await failed.locator("details").getAttribute("open")).toBeNull();
        expect(await failed.locator("summary").innerText()).toContain("exit 1");
        await showFold(page);
        await fold.click();

        // The newest message streams below the closed fold, then shrinks into it on more tools.
        emit({ itemId: "handoff", status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { phase: "commentary", text: "A visible progress message before another tool.\n\nThis message should smoothly move under the fold when work resumes.\n" } } }, true);
        const handoff = page.locator('[data-answer-item="handoff"]');
        await handoff.waitFor();
        await latest(page);
        await page.waitForTimeout(350);
        const sampleHandoff = region(page).evaluate(async (node) => {
          const samples: number[] = [];
          const until = performance.now() + 800;
          while (performance.now() < until) {
            samples.push(node.querySelector('[data-key^="answer:"]')?.getBoundingClientRect().height ?? 0);
            await new Promise(requestAnimationFrame);
          }
          return samples;
        });
        emit({ itemId: "resumed", status: ItemStatus.COMPLETED, content: { case: "commandExecution", value: { command: "git diff --check", exitCode: 0 } } });
        const handoffHeights = await sampleHandoff;
        expect(handoffHeights.some((h) => h > 1 && h < Math.max(...handoffHeights) - 1)).toBe(true);
        expect(handoffHeights.at(-1)).toBe(0);

        // Use the same final-message id before and at completion, as a real streaming worker does.
        const answerId = `msg-${turnId}`;
        emit({ itemId: answerId, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { text: "## Final answer starts here\n\n", phase: "final_answer" } } }, true);
        gw.worker.emit(threadId, turnId, { case: "itemDelta", value: { itemId: answerId, field: ItemDeltaField.TEXT, chunk: longAnswer.slice("## Final answer starts here\n\n".length) } });
        await page.getByRole("heading", { name: "Finding 28", exact: true }).waitFor();
        await latest(page);
        await page.waitForTimeout(350);
        const documentTop = await region(page).evaluate((node) => node.querySelector('[data-key^="answer:"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop);
        const samples = region(page).evaluate(async (node) => {
          const tops: number[] = [];
          const until = performance.now() + 1200;
          while (performance.now() < until) {
            tops.push(node.querySelector('[data-key^="answer:"]')!.getBoundingClientRect().top);
            await new Promise(requestAnimationFrame);
          }
          return tops;
        });
        gw.worker.finish(threadId, turnId, longAnswer);
        await page.getByRole("button", { name: /Worked for/ }).waitFor();
        const tops = await samples;
        const maxStep = Math.max(...tops.slice(1).map((top, i) => Math.abs(top - tops[i]!)));
        const offset = await region(page).evaluate((node) => node.querySelector('[data-key^="answer:"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top);
        const documentTopAfter = await region(page).evaluate((node) => node.querySelector('[data-key^="answer:"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop);
        console.info(`FINISH ${prefix}: max-frame=${maxStep.toFixed(2)}px, answer-offset=${offset.toFixed(2)}px`);
        // Smooth scroll covers several thousand pixels; reject a single-frame layout teleport.
        expect(maxStep).toBeLessThan(Math.abs(tops.at(-1)! - tops[0]!) * 0.45);
        expect(Math.abs(offset - 8)).toBeLessThan(2);
        expect(Math.abs(documentTopAfter - documentTop)).toBeLessThan(2);
        expect(await page.getByRole("button", { name: /Worked for/ }).getAttribute("aria-expanded")).toBe("false");
        await page.screenshot({ path: resolve(shots, `${prefix}-ended.png`) });
        await latest(page);

        // A fresh turn ends while the reader has deliberately scrolled away: keep that row fixed.
        const away = await newTurn(page);
        const awayId = `msg-${away.turnId}`;
        away.emit({ itemId: "away-command", status: ItemStatus.COMPLETED, content: { case: "commandExecution", value: { command: "bun test", exitCode: 0 } } });
        away.emit({ itemId: awayId, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { phase: "final_answer", text: longAnswer } } }, true);
        await page.getByRole("heading", { name: "Finding 28", exact: true }).waitFor();
        await latest(page);
        await region(page).hover({ position: { x: 100, y: 100 } });
        await page.mouse.wheel(0, -650);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        await page.waitForTimeout(600);
        const before = await page.locator(`[data-answer-item="${awayId}"]`).evaluate((node) => node.getBoundingClientRect().top);
        gw.worker.finish(away.threadId, away.turnId, longAnswer);
        await page.getByText("Thread idle", { exact: true }).waitFor({ state: "attached" });
        await page.waitForTimeout(700);
        const after = await page.locator(`[data-answer-item="${awayId}"]`).evaluate((node) => node.getBoundingClientRect().top);
        console.info(`AWAY ${prefix}: drift=${Math.abs(after - before).toFixed(2)}px`);
        expect(Math.abs(after - before)).toBeLessThan(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } catch (error) {
        console.info("TIMELINE FAILURE", await page.locator("body").innerText());
        await page.screenshot({ path: resolve(shots, `${prefix}-failure.png`) });
        throw error;
      } finally { await context.close(); }
    }, 90000);
  }

  test("short answer stays put; reduced motion aligns a long answer instantly", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      const short = await newTurn(page);
      short.emit({ itemId: `msg-${short.turnId}`, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { phase: "final_answer", text: "A short, complete answer." } } }, true);
      await page.getByText("A short, complete answer.", { exact: true }).waitFor();
      const before = await region(page).evaluate((node) => node.scrollTop);
      gw.worker.finish(short.threadId, short.turnId, "A short, complete answer.");
      await page.getByRole("button", { name: /Worked for/ }).waitFor();
      expect(await region(page).evaluate((node) => node.scrollTop)).toBe(before);
      const long = await newTurn(page);
      long.emit({ itemId: `msg-${long.turnId}`, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { phase: "final_answer", text: longAnswer } } }, true);
      await page.getByRole("heading", { name: "Finding 28", exact: true }).waitFor();
      await latest(page);
      gw.worker.finish(long.threadId, long.turnId, longAnswer);
      await page.getByRole("button", { name: /Worked for/ }).waitFor();
      expect(await eventually(() => region(page).evaluate((node) => node.querySelector('[data-key^="answer:"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top), (top) => Math.abs(top - 8) < 2)).toBeLessThan(10);
    } finally { await context.close(); }
  }, 30000);

  test("no browser exceptions", () => expect(problems).toEqual([]));
});
