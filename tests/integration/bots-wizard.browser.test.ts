/// <reference lib="dom" />
/** Opt-in UI acceptance, no gateway/worker/database. Own Vite on 5197, Chromium, mocked shell APIs.
 * OA_BOTS_WIZARD_BROWSER=1 bun test tests/integration/bots-wizard.browser.test.ts */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { eventually } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_BOTS_WIZARD_BROWSER"] !== "1")("bot wizard gallery", () => {
  const base = "http://127.0.0.1:5197";
  const shots = resolve(import.meta.dir, "../../artifacts/bots-wizard");
  let web: ReturnType<typeof Bun.spawn>;
  let browser: Browser;
  const problems: string[] = [];
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    web = Bun.spawn(["bun", "run", "dev", "--host", "127.0.0.1", "--port", "5197"], {
      cwd: resolve(import.meta.dir, "../../apps/web"), stdout: "ignore", stderr: "inherit",
      env: { ...Bun.env, GATEWAY_URL: "http://127.0.0.1:1", GATEWAY_SERVICE_TOKEN: "test-only-bots-wizard-service-token-00000000" },
    });
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
    expect(await eventually(() => fetch(base).then((r) => r.ok).catch(() => false), Boolean, 25000)).toBe(true);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
  });

  async function gallery(width = 1440, dark = false, reduced = false): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1100 }, isMobile: width === 390, hasTouch: width === 390, reducedMotion: reduced ? "reduce" : "no-preference" });
    context.setDefaultTimeout(10000);
    await context.addInitScript(() => {
      // Only this isolated gallery needs a ready shell; no real subscriptions or backend requests.
      window.EventSource = class extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("ready"))); }
        close() {}
      } as unknown as typeof EventSource;
    });
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path === "/api/settings" ? toJson(ui.GetSettingsResponseSchema, create(ui.GetSettingsResponseSchema, {
        user: { appearance: { colorScheme: dark ? ui.ColorScheme.DARK : ui.ColorScheme.LIGHT } },
      })) : {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const bootFailures: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning" && message.text().includes("[svelte]")) problems.push(message.text()); });
    page.on("requestfailed", (request) => bootFailures.push(request.failure()?.errorText ?? ""));
    for (let attempt = 0; attempt < 3; attempt++) {
      const checkpoint = problems.length;
      bootFailures.length = 0;
      try {
        await page.goto(`${base}/dev/bots`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Create New Bot", exact: true }).waitFor({ timeout: 5000 });
        break;
      } catch (cause) {
        // Docker-based tests on this host change interfaces. Retry only a proven Chromium network
        // reset during boot; application errors and failed interactions are never retried/hidden.
        const reset = bootFailures.some((failure) => failure.includes("ERR_NETWORK_CHANGED"));
        const onlyNetwork = problems.slice(checkpoint).every((problem) => problem.includes("ERR_NETWORK_CHANGED") || problem.startsWith("Failed to fetch dynamically imported module:"));
        if (attempt === 2 || !reset || !onlyNetwork) { await context.close(); throw cause; }
        console.info(`Gallery boot retry ${attempt + 1}: Chromium ERR_NETWORK_CHANGED`);
        problems.splice(checkpoint);
      }
    }
    return { context, page };
  }

  const dialog = (page: Page) => page.getByRole("dialog", { name: "Create New Bot", exact: true });
  async function open(page: Page) {
    await page.getByRole("button", { name: "Create New Bot", exact: true }).click();
    await dialog(page).waitFor();
  }
  async function shot(page: Page, name: string) {
    await page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  }

  for (const width of [1440, 390]) for (const dark of [false, true]) {
    test(`${width}px ${dark ? "dark" : "light"}: preview, grids, custom colour and save`, async () => {
      const { page, context } = await gallery(width, dark);
      try {
        await open(page);
        const modal = dialog(page);
        const name = modal.getByRole("textbox", { name: "Name your Bot" });
        await name.fill(`Nova ${width} ${dark ? "dark" : "light"}`);
        expect(await modal.getByRole("radio", { name: "Round", exact: true }).getAttribute("aria-checked")).toBe("true");
        await modal.getByRole("radio", { name: "Flower", exact: true }).click();
        await modal.getByRole("radio", { name: "Violet", exact: true }).click();
        await shot(page, `${width}-${dark ? "dark" : "light"}`);
        const bounds = await modal.boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(width);
        if (width === 390) expect(Math.abs(bounds!.y + bounds!.height - 844)).toBeLessThan(2);
        expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await modal.locator('input[type=color], input[type=range], input[type=radio], select').count()).toBe(0);

        await modal.getByRole("radio", { name: "Custom colour", exact: true }).click();
        const hex = modal.getByRole("textbox", { name: "Hex colour", exact: true });
        await hex.fill("#a3e635");
        await modal.getByRole("slider", { name: "Hue", exact: true }).focus();
        const before = await modal.getByRole("slider", { name: "Hue", exact: true }).getAttribute("aria-valuenow");
        await page.keyboard.press("ArrowRight");
        expect(await modal.getByRole("slider", { name: "Hue", exact: true }).getAttribute("aria-valuenow")).not.toBe(before);
        await hex.fill("#a3e635");
        await shot(page, `${width}-${dark ? "dark" : "light"}-custom`);
        const fill = await modal.locator('.t-icon-swap[data-state=a] [data-icon=a] .eyes, .t-icon-swap[data-state=b] [data-icon=b] .eyes').evaluate((el) => getComputedStyle(el).fill);
        expect(fill).toBe("rgb(24, 24, 27)");
        await name.focus();
        await page.keyboard.press("Enter");
        await modal.getByText("Creating your bot…", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        expect(await modal.isVisible()).toBe(true);
        expect(await modal.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
        await modal.waitFor({ state: "hidden" });
        expect(await page.getByText("1 bots created in this gallery session.", { exact: true }).isVisible()).toBe(true);
        const payload = JSON.parse(await page.getByLabel("Last created bot draft").innerText());
        expect(payload).toMatchObject({ shape: "flower", color: "#a3e635", providerInstanceId: "codex-personal", model: "gpt-6.1-sol" });
        await open(page);
        expect(await dialog(page).getByRole("textbox", { name: "Name your Bot" }).inputValue()).toBe("");
      } finally { await context.close(); }
    }, 60000);
  }

  test("keyboard-only: validation, wrapping grids, provider/model/effort and create", async () => {
    const { page, context } = await gallery();
    try {
      // Starting at the page's first tab stop, reach and activate the launch button using only keys.
      for (let n = 0; n < 80; n++) {
        if (await page.getByRole("button", { name: "Create New Bot", exact: true }).evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      expect(await page.getByRole("button", { name: "Create New Bot", exact: true }).evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      const modal = dialog(page);
      const name = modal.getByRole("textbox", { name: "Name your Bot" });
      expect(await name.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await modal.getByRole("button", { name: "Create Bot", exact: true }).evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      expect(await name.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await modal.getByText("Give your bot a name.", { exact: true }).first().waitFor();
      await page.keyboard.type(" canopy BOT ");
      await page.keyboard.press("Enter");
      await modal.getByText("A bot with this name already exists. Choose another name.", { exact: true }).first().waitFor();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("Keyboard Pal");
      await page.keyboard.press("Tab");
      await page.keyboard.press("ArrowLeft");
      expect(await modal.getByRole("radio", { name: "Pumpkin", exact: true }).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      expect(await modal.getByRole("radio", { name: "Droplet", exact: true }).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Tab");
      await page.keyboard.press("End");
      const hex = modal.getByRole("textbox", { name: "Hex colour", exact: true });
      await hex.waitFor();
      // Custom sliders and hex are all keyboard-reachable, without focusing via script.
      for (let n = 0; n < 4; n++) await page.keyboard.press("Tab");
      expect(await hex.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("#123");
      await page.keyboard.press("Tab");
      await page.keyboard.press("ArrowRight");
      expect(await modal.getByRole("radio", { name: "Claude · Team", exact: true }).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.getByRole("combobox", { name: "Search models" }).waitFor();
      await page.keyboard.type("sonnet");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.getByRole("combobox", { name: "Search models" }).waitFor({ state: "hidden" });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      const effort = page.getByRole("slider", { name: "Reasoning effort", exact: true });
      await effort.waitFor();
      await page.keyboard.press("End");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await modal.waitFor({ state: "hidden" });
      expect(JSON.parse(await page.getByLabel("Last created bot draft").innerText())).toMatchObject({ name: "Keyboard Pal", shape: "droplet", color: "#112233", providerInstanceId: "claude-team", model: "sonnet", effort: "max" });
    } finally { await context.close(); }
  }, 60000);

  test("errors preserve draft, empty instances block create, edit keeps its name", async () => {
    const { page, context } = await gallery();
    try {
      await page.getByRole("button", { name: "Save error", exact: true }).click();
      await open(page);
      const modal = dialog(page);
      await modal.getByRole("textbox", { name: "Name your Bot" }).fill("Retry Pal");
      await modal.getByRole("radio", { name: "Custom colour", exact: true }).click();
      const hex = modal.getByRole("textbox", { name: "Hex colour", exact: true });
      await hex.fill("#x");
      await hex.press("Enter");
      await modal.getByRole("alert").filter({ hasText: "Enter a colour" }).waitFor();
      await hex.fill("#abc");
      await modal.getByRole("button", { name: "Create Bot", exact: true }).click();
      await modal.getByRole("alert").filter({ hasText: "The provider is unavailable" }).waitFor();
      expect(await modal.getByRole("textbox", { name: "Name your Bot" }).inputValue()).toBe("Retry Pal");
      await modal.getByRole("button", { name: "Model: GPT-6.1 Sol", exact: true }).click();
      const search = page.getByRole("combobox", { name: "Search models" });
      await search.fill("luna");
      await search.press("ArrowDown");
      await search.press("Enter");
      await search.waitFor({ state: "hidden" });
      expect(await modal.getByRole("button", { name: /^Reasoning effort:/ }).count()).toBe(0);
      await modal.getByRole("radio", { name: "Codex · Lab", exact: true }).click();
      expect(await modal.getByRole("button", { name: "Create Bot", exact: true }).isDisabled()).toBe(true);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "No providers", exact: true }).click();
      await open(page);
      expect(await modal.getByRole("button", { name: "Create Bot", exact: true }).isDisabled()).toBe(true);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Edit Bot appearance", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit Bot appearance", exact: true });
      expect(await edit.getByRole("textbox", { name: "Name your Bot" }).inputValue()).toBe("Orbit");
      await edit.getByRole("radio", { name: "Pumpkin", exact: true }).click();
      await edit.getByRole("button", { name: "Save changes", exact: true }).click();
      await edit.waitFor({ state: "hidden" });
      expect(await page.getByRole("img", { name: "Orbit", exact: true }).locator("path").getAttribute("d")).toContain("V5");
    } finally { await context.close(); }
  }, 60000);

  test("shape crossfade, typing reaction and reduced-motion static preview", async () => {
    for (const reduced of [false, true]) {
      const { page, context } = await gallery(1440, false, reduced);
      try {
        await open(page);
        const modal = dialog(page);
        await modal.getByRole("radio", { name: "Clover", exact: true }).click();
        const transition = await modal.locator(".t-icon").first().evaluate((el) => getComputedStyle(el).transitionDuration);
        expect(transition.split(", ").every((time) => time === (reduced ? "0s" : "0.25s"))).toBe(true);
        const animation = await modal.locator(".blinking").evaluate((el) => getComputedStyle(el).animationName);
        expect(animation === "none").toBe(reduced);
        await modal.getByRole("textbox", { name: "Name your Bot" }).fill("Motion Pal");
        expect(await modal.locator(".t-icon-swap").evaluate((el) => el.getAnimations().length > 0)).toBe(!reduced);
        // Every path is real SVG geometry; closed bodies fit the shared 40×40 coordinate system.
        for (const shape of await modal.getByRole("radiogroup", { name: "Bot shape" }).locator("svg path").all()) {
          const box = await shape.evaluate((el) => { const b = (el as SVGPathElement).getBBox(); return { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height }; });
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(40); expect(box.bottom).toBeLessThanOrEqual(40);
        }
      } finally { await context.close(); }
    }
    expect(problems).toEqual([]);
  }, 60000);
});
