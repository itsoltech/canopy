/// <reference lib="dom" />
/** Explicit opt-in, isolated Vite/Chromium and mocked shell transport. No shared stack.
 * OA_MASCOTS_BROWSER=1 bun test apps/web/src/lib/features/bots/gallery/behaviour.browser.test.ts
 * Playwright remains owned by tests/integration; keep mascot changes within the feature. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "../../../../../../../tests/integration/node_modules/playwright-core/index.js";

describe.skipIf(Bun.env["OA_MASCOTS_BROWSER"] !== "1")("living mascots", () => {
  const root = resolve(import.meta.dir, "../../../../../../..");
  const base = "http://127.0.0.1:5196";
  const artifacts = resolve(root, ".tmp/living-mascots");
  let web: ReturnType<typeof Bun.spawn>;
  let browser: Browser;
  const problems: string[] = [];
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true });
    web = Bun.spawn(["bun", "run", "dev", "--host", "127.0.0.1", "--port", "5196"], {
      cwd: resolve(root, "apps/web"), stdout: "ignore", stderr: "inherit",
      env: { ...process.env, GATEWAY_URL: "http://127.0.0.1:1", GATEWAY_SERVICE_TOKEN: "mascot-gallery-test-only-service-token-000000" },
    });
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(base).then((r) => r.ok).catch(() => false)) return;
      if (web.exitCode !== null) throw new Error(`Vite exited: ${web.exitCode}`);
      await Bun.sleep(100);
    }
    throw new Error("Private Vite did not start on 5196");
  }, 30000);
  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
  });

  async function gallery({ dark = false, reduced = false, touch = false } = {}): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1440, height: touch ? 844 : 1100 },
      isMobile: touch, hasTouch: touch, reducedMotion: reduced ? "reduce" : "no-preference" });
    context.setDefaultTimeout(10000);
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("ready"))); }
        close() {}
      } as unknown as typeof EventSource;
    });
    // Proxy responses through Playwright's client to isolate Chromium from host interface changes.
    await context.route("**/*", async (route) => route.fulfill({ response: await route.fetch() }));
    await context.routeWebSocket("ws://127.0.0.1:5196/**", (socket) => socket.send(JSON.stringify({ type: "connected" })));
    await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      new URL(route.request().url()).pathname === "/api/settings" ? { user: { appearance: { colorScheme: dark ? "COLOR_SCHEME_DARK" : "COLOR_SCHEME_LIGHT" } } } : {},
    ) }));
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(`${base}/dev/bots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-mascot-grid] [data-mascot-gaze][transform]").first().waitFor({ state: reduced ? "hidden" : "attached", timeout: reduced ? 500 : 10000 }).catch((cause) => { if (!reduced) throw cause; });
    await page.getByRole("heading", { name: "Living mascots", exact: true }).waitFor();
    return { context, page };
  }

  const eyes = (page: Page) => page.locator("[data-mascot-grid] [data-mascot-gaze]").first();
  const offset = (page: Page) => eyes(page).evaluate((element) => {
    const matrix = (element as SVGGElement).transform.baseVal.consolidate()?.matrix;
    return { x: matrix?.e ?? 0, y: matrix?.f ?? 0 };
  });
  async function expression(page: Page, state: string) {
    await page.getByRole("combobox", { name: "Mascot expression", exact: true }).click();
    await page.getByRole("option", { name: state, exact: true }).click();
    await page.mouse.move(1300, 1000);
  }
  async function sample(page: Page, count = 24) {
    return page.locator("[data-mascot-grid]").evaluate(async (grid, frames) => {
      const first = grid.querySelector<SVGGElement>("[data-mascot-character]")!;
      const values: string[] = [];
      for (let i = 0; i < frames; i++) {
        await new Promise(requestAnimationFrame);
        values.push(first.getAttribute("transform") ?? "");
      }
      return values;
    }, count);
  }

  for (const dark of [false, true]) test(`${dark ? "dark" : "light"}: pointer, 50 mascots and frame budget`, async () => {
    const { context, page } = await gallery({ dark });
    try {
      expect(await page.locator("[data-mascot-grid] [data-mascot]").count()).toBe(50);
      await page.mouse.move(300, 180, { steps: 10 });
      await page.waitForTimeout(300);
      const left = await offset(page);
      expect(left.x).toBeLessThan(0);
      expect(left.y).toBeLessThan(0);
      await page.screenshot({ path: resolve(artifacts, `${dark ? "dark" : "light"}-look-left.png`) });
      await page.mouse.move(1350, 1000, { steps: 20 });
      await page.waitForTimeout(300);
      const right = await offset(page);
      expect(right.x).toBeGreaterThan(0);
      expect(right.y).toBeGreaterThan(0);
      await page.screenshot({ path: resolve(artifacts, `${dark ? "dark" : "light"}-look-right.png`) });
      for (const label of ["Tiny static mascot", "Small static avatar", "Disabled mascot"]) {
        expect(await page.getByRole("img", { name: label, exact: true }).locator("[transform]").count()).toBe(0);
      }
      expect(new Set(await sample(page)).size).toBeGreaterThan(1);

      const budget = await page.locator("[data-mascot-grid]").evaluate(async (grid) => {
        const rect = grid.getBoundingClientRect();
        const tasks: number[] = [];
        const frames: number[] = [];
        const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration); });
        observer.observe({ type: "longtask" });
        let previous = performance.now();
        for (let i = 0; i < 180; i++) {
          const now = await new Promise<number>(requestAnimationFrame);
          frames.push(now - previous); previous = now;
          window.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.x + rect.width * (0.5 + Math.sin(i / 20) * 0.5), clientY: rect.y + rect.height + 50, pointerType: "mouse" }));
        }
        observer.disconnect();
        const sorted = frames.slice(1).sort((a, b) => a - b);
        return { mascots: grid.querySelectorAll("[data-mascot-character][transform]").length,
          p95: sorted[Math.floor(sorted.length * 0.95)]!, mean: sorted.reduce((sum, n) => sum + n, 0) / sorted.length,
          maxFrame: Math.max(...sorted), longTasks: tasks };
      });
      writeFileSync(resolve(artifacts, `${dark ? "dark" : "light"}-performance.json`), JSON.stringify(budget, null, 2));
      console.info(`${dark ? "dark" : "light"} frame budget`, budget);
      expect(budget.mascots).toBe(50);
      expect(budget.p95).toBeLessThan(35);
      expect(budget.mean).toBeLessThan(25);
      expect(budget.longTasks.length).toBe(0);
    } finally { await context.close(); }
  }, 60000);

  test("expressions, one attention animation, off-screen and tab suspension", async () => {
    const { context, page } = await gallery();
    try {
      await expression(page, "working");
      await page.waitForTimeout(350);
      expect((await offset(page)).x).toBeLessThan(0);
      expect((await offset(page)).y).toBeGreaterThan(0);
      await expression(page, "waiting");
      await page.waitForTimeout(350);
      expect((await offset(page)).y).toBeGreaterThan(0);
      // All fifty receive the event together. Only one may have a squash in the same frame.
      await expression(page, "idle");
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Send / receive message", exact: true }).click();
      const simultaneous = await page.locator("[data-mascot-grid]").evaluate(async (grid) => {
        let max = 0;
        for (let i = 0; i < 25; i++) {
          await new Promise(requestAnimationFrame);
          const count = [...grid.querySelectorAll<SVGGElement>("[data-mascot-character]")].filter((group) => {
            const matrix = group.transform.baseVal.consolidate()?.matrix;
            return matrix && Math.abs(matrix.a - matrix.d) > 0.002;
          }).length;
          max = Math.max(max, count);
        }
        return max;
      });
      expect(simultaneous).toBe(1);
      for (const state of ["typing", "done", "error"]) await expression(page, state);
      await expression(page, "idle");
      // IntersectionObserver follows the actual gallery's scrolling ancestor.
      await page.getByRole("heading", { name: "Timeline pieces", exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      expect(await page.locator("[data-mascot-grid] [transform]").count()).toBe(0);
      await page.getByRole("heading", { name: "Living mascots", exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      expect(new Set(await sample(page)).size).toBeGreaterThan(1);
      // Deterministic visibility fixture: dispatch the same lifecycle event a hidden tab emits.
      await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
      expect(await page.locator("[data-mascot-grid] [transform]").count()).toBe(0);
      expect(new Set(await sample(page)).size).toBe(1);
      await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
      expect(new Set(await sample(page)).size).toBeGreaterThan(1);
    } finally { await context.close(); }
  }, 60000);

  test("reduced motion is fully static at boot and after a live change; setting persists", async () => {
    for (const reduced of [true, false]) {
      const { context, page } = await gallery({ reduced });
      try {
        if (!reduced) await page.emulateMedia({ reducedMotion: "reduce" });
        await page.mouse.move(1300, 900, { steps: 10 });
        await page.getByRole("button", { name: "Send / receive message", exact: true }).click();
        expect(await page.locator("[data-mascot-grid] [transform]").count()).toBe(0);
        expect(new Set(await sample(page)).size).toBe(1);
        await page.screenshot({ path: resolve(artifacts, `reduced-${reduced ? "boot" : "live"}.png`) });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(new Set(await sample(page)).size).toBeGreaterThan(1);
        const toggle = page.getByRole("checkbox", { name: "Animated mascots", exact: true });
        await toggle.uncheck();
        expect(await page.locator("[data-mascot-grid] [transform]").count()).toBe(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await toggle.waitFor();
        expect(await toggle.isChecked()).toBe(false);
        expect(await page.locator("[data-mascot-grid] [transform]").count()).toBe(0);
        await toggle.check();
        expect(new Set(await sample(page)).size).toBeGreaterThan(1);
      } finally { await context.close(); }
    }
  }, 60000);

  test("touch glance returns to idle; wizard click and keyboard wobble, name reaction", async () => {
    const { context, page } = await gallery({ touch: true });
    try {
      await page.touchscreen.tap(370, 400);
      await page.waitForTimeout(250);
      expect((await offset(page)).x).toBeGreaterThan(0);
      await page.waitForTimeout(1300);
      expect(Math.abs((await offset(page)).x)).toBeLessThan(0.02);
      await page.screenshot({ path: resolve(artifacts, "mobile-idle.png") });
      await page.getByRole("button", { name: "Create New Bot", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "Create New Bot", exact: true });
      const preview = modal.getByRole("button", { name: "Play with your bot", exact: true });
      await preview.waitFor();
      await page.waitForTimeout(400);
      await preview.tap();
      const isWobbling = () => modal.locator(".t-icon-swap [data-mascot-character]").evaluateAll((groups) => groups.some((group) => {
        const matrix = (group as SVGGElement).transform.baseVal.consolidate()?.matrix;
        return matrix && Math.abs(matrix.b) > 0.005;
      }));
      await page.waitForTimeout(100);
      expect(await isWobbling()).toBe(true);
      await page.waitForTimeout(500);
      await preview.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      expect(await isWobbling()).toBe(true);
      await page.waitForTimeout(500);
      await modal.getByRole("textbox", { name: "Name your Bot", exact: true }).fill("Orbit Junior");
      await page.waitForTimeout(80);
      expect(await modal.locator(".t-icon-swap [data-mascot-character]").evaluateAll((groups) => groups.some((group) => {
        const matrix = (group as SVGGElement).transform.baseVal.consolidate()?.matrix;
        return matrix && matrix.f < -0.05;
      }))).toBe(true);
      await page.screenshot({ path: resolve(artifacts, "mobile-wizard.png") });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await modal.getByRole("button", { name: "Play with Orbit Junior", exact: true }).tap();
      expect(await modal.locator(".t-icon-swap [transform]").count()).toBe(0);
    } finally { await context.close(); }
    expect(problems).toEqual([]);
  }, 60000);
});
