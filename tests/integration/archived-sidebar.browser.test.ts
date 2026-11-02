/** OA_ARCHIVE_BROWSER=1 bun test tests/integration/archived-sidebar.browser.test.ts
 * Own PostgreSQL/gateway/scripted worker and built web on 5396. No shared development stack. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { BrowserContext, Page, Locator } from "playwright-core";
import { Provider, ui } from "@open-agents/contracts";
import { tempDirs } from "@open-agents/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(Bun.env["OA_ARCHIVE_BROWSER"] !== "1")("archived sidebar browser acceptance", () => {
  const makeTemp = tempDirs();
  const shots = resolve(import.meta.dir, "../../artifacts/sidebar-archived-section");
  const base = "http://127.0.0.1:5396";
  const problems: string[] = [];
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let desktop: BrowserContext;
  let mobile: BrowserContext;
  let alpha: ui.Project;
  let parent: ui.Thread;
  let side: ui.Thread;
  let previous: ui.Thread;
  let archived: ui.Thread;
  const screenshot = (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
  const rows = (section: Locator) => section.locator("[data-archived-row]");
  const waitCount = async (locator: Locator, count: number) => expect(await eventually(() => locator.count(), (n) => n === count)).toBe(count);
  const setTheme = async (theme: "light" | "dark") => {
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, appearance: { ...settings.appearance!, colorScheme: theme === "light" ? ui.ColorScheme.LIGHT : ui.ColorScheme.DARK } });
  };

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway();
    alpha = (await gw.api.createProject({ name: "Archive Alpha" })).project!;
    const beta = (await gw.api.createProject({ name: "Archive Beta" })).project!;
    const workspace = (await gw.api.createWorkspace({ projectId: alpha.id, workerId: gw.workerId, rootPath: "/repo/archive" })).workspace!;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion > 0n));
    const create = async (title: string, parentThreadId = "") => {
      const thread = (await gw.api.createThread({ projectId: alpha.id, workspaceId: workspace.id, provider: Provider.CODEX, title, parentThreadId })).thread!;
      return (await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle")).thread!;
    };
    parent = await create("Archive the whole tree");
    side = await create("Active cascade helper", parent.id);
    previous = await create("Previously closed helper", parent.id);
    await gw.api.setThreadArchived({ threadId: previous.id, archived: true });
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (let i = 0; i < 90; i++) {
        const id = Bun.randomUUIDv7();
        yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, title, status, archived_at)
          VALUES (${id}::uuid, ${id}::uuid, ${i < 50 || i >= 55 ? alpha.id : beta.id}::uuid, ${gw.userId}::uuid,
            'main', 'gateway', 'openai', ${i < 55 ? `Archived conversation ${String(i).padStart(2, "0")} with a title long enough to truncate` : `Active conversation ${i}`},
            ${i < 55 ? "archived" : "idle"}, ${i < 55 ? new Date(Date.now() - i * 3600000) : null})`;
      }
    }));
    archived = (await gw.api.listArchivedThreads({})).threads[0]!;
    web = Bun.spawn(["bun", "build/index.js"], { cwd: resolve(import.meta.dir, "../../apps/web"),
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: "5396", GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN, ORIGIN: base }, stdout: "ignore", stderr: "inherit" });
    expect(await eventually(async () => fetch(`${base}/api/settings`).then((r) => r.ok).catch(() => false), Boolean, 20_000)).toBe(true);
    const { chromium } = createRequire(import.meta.url)("playwright-core") as typeof import("playwright-core");
    const options = { executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] };
    desktop = await chromium.launchPersistentContext(makeTemp("oa-archive-desktop-"), { ...options, viewport: { width: 1440, height: 1000 } });
    mobile = await chromium.launchPersistentContext(makeTemp("oa-archive-mobile-"), { ...options, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    for (const context of [desktop, mobile]) {
      context.setDefaultTimeout(10_000);
      context.on("page", (page) => page.on("pageerror", (error) => problems.push(error.message)));
    }
  }, 60_000);
  afterAll(async () => {
    await desktop?.close(); await mobile?.close();
    web?.kill(); if (web) await web.exited;
    await gw?.close();
  }, 30_000);

  test("1440 and 390: both themes, paging, persisted collapse and sticky current while scrolling", async () => {
    for (const [size, context] of [["desktop", desktop], ["mobile", mobile]] as const) {
      const page = await context.newPage();
      for (const theme of ["light", "dark"] as const) {
        await setTheme(theme);
        const settings = (await gw.api.getSettings({})).user!;
        await gw.api.updateUserSettings({ expectedVersion: settings.version, sidebar: { archivedExpanded: false } });
        const requests: boolean[] = [];
        page.on("response", async (response) => {
          if (response.url().includes("/api/threads/archived?")) {
            const json = await response.json().catch(() => undefined) as { threads?: unknown[] } | undefined;
            if (new URL(response.url()).searchParams.get("countOnly") === "true") requests.push(!json?.threads?.length);
          }
        });
        await page.goto(`${base}/threads/${archived.id}`);
        if (size === "mobile") await page.getByRole("button", { name: "Open menu", exact: true }).click();
        const shell = size === "mobile" ? page.getByRole("dialog", { name: "Navigation", exact: true }) : page.getByRole("complementary", { name: "Sidebar", exact: true });
        const nav = shell.getByRole("navigation", { name: "Threads", exact: true });
        const section = nav.locator("[data-archived-section]");
        const header = section.getByRole("button", { name: /Archived ·/ });
        await section.locator('[aria-label="55 archived threads"]').waitFor();
        expect(await header.getAttribute("aria-expanded")).toBe("false");
        await section.locator("[data-archived-current] a[aria-current=page]").waitFor();
        await waitCount(rows(section), 1);
        await nav.evaluate((node) => { node.scrollTop = 0; });
        const initial = await section.boundingBox();
        const navBox = await nav.boundingBox();
        expect(initial!.y + initial!.height).toBeLessThanOrEqual(navBox!.y + navBox!.height + 1);
        await nav.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        const scrolled = await section.boundingBox();
        expect(Math.abs(initial!.y - scrolled!.y)).toBeLessThan(2);
        await screenshot(page, `${size}-${theme}-collapsed-current`);
        await header.click();
        await waitCount(rows(section), 20);
        const first = rows(section).first();
        const linkBox = (await first.locator("a").boundingBox())!;
        const timeBox = (await first.locator("time").boundingBox())!;
        const expandedNavBox = (await nav.boundingBox())!; // the mobile drawer has finished its entrance now
        expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(expandedNavBox.x + expandedNavBox.width);
        expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width);
        expect(await first.locator(".truncate").evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
        await section.getByRole("button", { name: "Load more", exact: true }).click();
        await waitCount(rows(section), 40);
        await section.getByRole("button", { name: "Load more", exact: true }).click();
        await waitCount(rows(section), 55);
        expect(await section.getByRole("button", { name: "Load more", exact: true }).count()).toBe(0);
        expect(new Set(await rows(section).evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-archived-row")))).size).toBe(55);
        await header.scrollIntoViewIfNeeded();
        await screenshot(page, `${size}-${theme}-expanded`);
        await header.click();
        expect((await eventually(() => gw.api.getSettings({}), (s) => s.user?.sidebar?.archivedExpanded === false)).user?.sidebar?.archivedExpanded).toBe(false);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(Boolean)).toBe(true);
        await page.reload();
        if (size === "mobile") await page.getByRole("button", { name: "Open menu", exact: true }).click();
        await section.locator("[data-archived-current] a[aria-current=page]").waitFor();
        expect(await header.getAttribute("aria-expanded")).toBe("false");
      }
      await page.close();
    }
    expect(problems).toEqual([]);
  }, 180_000);

  test("live cascade, grouped children, menu restore, search/filter and reduced motion", async () => {
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: settings.version, sidebar: { archivedExpanded: false } });
    const page = await desktop.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}/threads/${parent.id}`);
    const shell = page.getByRole("complementary", { name: "Sidebar", exact: true });
    const nav = shell.getByRole("navigation", { name: "Threads", exact: true });
    const inbox = nav.getByRole("list", { name: "Thread inbox", exact: true });
    const section = nav.locator("[data-archived-section]");
    const header = section.getByRole("button", { name: /Archived ·/ });
    await section.locator('[aria-label="55 archived threads"]').waitFor();
    expect(await header.getAttribute("aria-expanded")).toBe("false");
    await waitCount(rows(section), 0);
    await inbox.locator(`a[href="/threads/${side.id}"]`).waitFor();
    const parentRow = inbox.locator(`a[href="/threads/${parent.id}"]`);
    await parentRow.press("Shift+F10");
    await page.getByRole("menu", { name: `Actions for ${parent.title}`, exact: true }).getByRole("menuitem", { name: "Archive thread", exact: true }).click();
    await section.locator('[aria-label="56 archived threads"]').waitFor();
    await inbox.locator(`a[href="/threads/${side.id}"]`).waitFor({ state: "hidden" });
    await inbox.locator(`a[href="/threads/${parent.id}"]`).waitFor({ state: "hidden" });
    await header.click();
    const archivedParent = section.getByRole("list", { name: "Archived threads", exact: true }).locator(`[data-archived-row="${parent.id}"]`);
    await archivedParent.waitFor();
    await section.getByRole("button", { name: /Previous agents/ }).click();
    await waitCount(section.locator(`a[href="/threads/${side.id}"]`), 1);
    await waitCount(section.locator(`a[href="/threads/${previous.id}"]`), 1);
    await screenshot(page, "desktop-dark-cascade-group");
    await archivedParent.locator("a").press("Shift+F10");
    await page.getByRole("menu", { name: `Actions for ${parent.title}`, exact: true }).getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await section.locator('[aria-label="55 archived threads"]').waitFor();
    await inbox.locator(`a[href="/threads/${side.id}"]`).waitFor();
    expect((await gw.api.getThread({ threadId: previous.id })).thread?.status).toBe("archived");
    await shell.getByPlaceholder("Search threads", { exact: true }).fill("conversation 01");
    await section.locator('[aria-label="1 archived threads"]').waitFor();
    await waitCount(rows(section), 1);
    await shell.getByPlaceholder("Search threads", { exact: true }).fill("");
    await shell.getByRole("button", { name: "Filter projects", exact: true }).click();
    const filter = page.getByRole("dialog", { name: "Filter threads", exact: true });
    expect(await filter.getByRole("checkbox", { name: "Archived threads", exact: true }).count()).toBe(0);
    await filter.getByRole("checkbox", { name: "Archive Beta", exact: true }).check();
    await section.locator('[aria-label="5 archived threads"]').waitFor();
    await waitCount(rows(section), 5);
    await page.keyboard.press("Escape");
    expect(await section.locator(".t-acc-chevron").evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).transitionDuration)).toBe("0s");
    const row = rows(section).first();
    const height = (await row.boundingBox())!.height;
    await row.hover();
    expect((await row.boundingBox())!.height).toBe(height);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
});
