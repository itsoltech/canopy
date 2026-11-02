/// <reference lib="dom" />
/**
 * Opt-in browser acceptance of the Bots chat on its own throwaway stack: gateway + Postgres (Docker), a scripted
 * bot model, a local MCP fixture ("Notion"), Vite on 5296 and Chromium. Seeds a real conversation through the
 * gateway (bot ⇄ bot exchange, question, approval, failed reply, live status) and drives it like a person.
 *   OA_BOTS_CHAT_BROWSER=1 bun test tests/integration/bots-chat.browser.test.ts
 * Screenshots: artifacts/bots-chat/ (1440 and 390 px, light and dark).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, ProfileModelsSchema, Provider, ProviderProfileKind } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { BotModel, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });
const tool = (name: string, args: Record<string, unknown>): ModelReply => ({ text: "", calls: [{ id: "call", name, arguments: args }] });
const lastInput = (input: ModelInput) => input.messages.findLast((m) => m.role === "user")?.text ?? "";

describe.skipIf(Bun.env["OA_BOTS_CHAT_BROWSER"] !== "1" || !dockerAvailable)("bots chat in the browser", () => {
  const port = 5296;
  const base = `http://127.0.0.1:${port}`;
  const shots = resolve(import.meta.dir, "../../artifacts/bots-chat");
  let gw: TestGateway;
  let web: ReturnType<typeof Bun.spawn>;
  let browser: Browser;
  let notion: ReturnType<typeof Bun.serve>;
  let releaseSearch = Promise.withResolvers<void>();
  let failing = true;
  const id = { kropek: "", crm: "", grok: "" };
  const problems: string[] = [];

  const model: BotModel = async (input) => {
    const last = input.messages.at(-1)!;
    const text = lastInput(input);
    if (input.configuration.name === "FIXme CRM") return reply("ACME ma otwarte **2 zgłoszenia** (wsparcie, faktura), ostatni kontakt wczoraj.");
    if (input.configuration.name === "Grok Bot") return reply("Gotowe — sprawdź `wynik`.");
    if (last.role === "tool") {
      const call = input.messages.findLast((m) => m.role === "assistant")?.calls?.[0]?.name;
      const result = JSON.parse(last.text) as { status?: string; edited?: string; answer?: string };
      if (call === "send_bot_message") return reply("Zapytałem **FIXme CRM** — dam znać, gdy odpowie.");
      if (call === "ask_user") return tool("start_thread", {
        project_id: "crm", workspace_id: "main", provider: "claude", provider_instance: "bots-ui", model: "claude-opus-5-5", permission: "full_auto",
        prompt: `Utwórz w bazie ${result.answer} notatkę: ACME — 2 otwarte zgłoszenia (wsparcie, faktura). Ostatni kontakt: wczoraj. Następny krok: telefon do opiekuna w piątek.`,
      });
      if (call === "start_thread") return reply(result.status === "changes_requested" ? `Jasne, zapiszę Twoją wersję:\n\n> ${result.edited}` : "Zapisane.");
      return reply("W Notion są **3 strony** o ACME:\n\n1. Umowa serwisowa\n2. Notatki ze spotkań\n3. Faktury 2026");
    }
    if (text.startsWith("Message from FIXme CRM")) return reply("FIXme CRM mówi, że **ACME** ma 2 otwarte zgłoszenia, a ostatni kontakt był wczoraj. Przygotować notatkę?");
    if (text.includes("Zapytaj FIXme CRM")) return tool("send_bot_message", { bot_id: id.crm, text: "Jaki jest status klienta ACME?" });
    if (text.includes("notatk")) return tool("ask_user", { question: "Do której bazy Notion zapisać notatkę?", options: ["Klienci", "Spotkania", "Notatki zespołu"] });
    if (text.includes("Notion")) return tool(input.tools.find((t) => t.source === "mcp")!.name, { query: "ACME" });
    if (text.includes("Spróbuj")) {
      if (failing) throw new Error("Model endpoint returned HTTP 400");
      return reply("Teraz działa — model odpowiada.");
    }
    return reply("Pomagam Ci z projektami: sprawdzam wątki, uruchamiam agentów i rozmawiam z innymi botami, np. z FIXme CRM.");
  };

  const read = (botId: string) => gw.core.bots.run((s) => s.conversation(gw.userId, botId));
  const settledWith = (botId: string, done: (s: bots.BotConversation) => boolean) => eventually(() => read(botId), (s) => !s.working && done(s), 15_000);

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    gw = await startTestGateway({ botModel: (input) => model(input) });
    gw.core.bots.start();
    notion = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as { id?: number; method: string };
      if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (body.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "notion", version: "1" }, capabilities: { tools: {} } };
      if (body.method === "tools/list") result = { tools: [{ name: "search", description: "Search pages", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }] };
      if (body.method === "tools/call") { await releaseSearch.promise; result = { content: [{ type: "text", text: "3 pages" }] }; }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    } });
    await gw.api.saveProviderInstance({ harness: Provider.CLAUDE, id: "bots-ui", label: "Claude proxy", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
    // A catalog where `default` is an alias, as Claude Code reports it; a worker of its own so the scripted one does not replace it.
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workerId = Bun.randomUUIDv7();
      const catalog = create(ProfileModelsSchema, { provider: Provider.CLAUDE, profileId: "bots-ui", models: [{ id: "default", resolvedModel: "claude-opus-5-5", isDefault: true }, { id: "claude-sonnet-5-5" }] });
      yield* sql`INSERT INTO workers (id, name, credential_hash) VALUES (${workerId}::uuid, 'catalog only', 'unused')`;
      yield* sql`INSERT INTO worker_model_catalogs (worker_id, profiles) VALUES (${workerId}::uuid, ${JSON.stringify([toJson(ProfileModelsSchema, catalog)])}::jsonb)`;
    }));
    const server = (await gw.api.saveBotMcpServer({ name: "Notion", url: `${notion.url}mcp`, transport: "http", enabled: true })).server!;
    const add = async (name: string, shape: string, color: string, mcp: string[] = []) => (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name, shape, color, provider: Provider.CLAUDE, providerInstance: "bots-ui", model: "default", approvalPolicy: "safe", mcpServerIds: mcp,
    } })).bot!;
    const kropek = await add("Kropek", "round", "#f97316", [server.id]);
    expect(kropek.configuration?.model).toBe("claude-opus-5-5");
    id.kropek = kropek.id;
    id.crm = (await add("FIXme CRM", "ghost", "#8b5cf6")).id;
    id.grok = (await add("Grok Bot", "blob", "#0ea5e9")).id;
    await gw.api.updateUserSettings({ sidebar: { pinnedBotIds: [id.kropek] } });
    const say = (botId: string, text: string) => gw.api.sendBotMessage({ botId, text, clientRequestId: Bun.randomUUIDv7() });
    await say(id.grok, "Policz wynik");
    await say(id.kropek, "Hej! Czym się zajmujesz?");
    await settledWith(id.kropek, (s) => s.messages.length === 2);
    await say(id.kropek, "Zapytaj FIXme CRM o status klienta ACME.");
    await settledWith(id.kropek, (s) => s.messages.some((m) => m.text.startsWith("FIXme CRM mówi")));

    web = Bun.spawn(["bun", "run", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: resolve(import.meta.dir, "../../apps/web"), stdout: "ignore", stderr: "inherit",
      env: { ...Bun.env, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN },
    });
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
    expect(await eventually(() => fetch(base).then((r) => r.ok).catch(() => false), Boolean, 30_000)).toBe(true);
  }, 90_000);

  afterAll(async () => {
    releaseSearch.resolve();
    await browser?.close();
    web?.kill();
    if (web) await web.exited;
    await gw?.core.bots.stop();
    await notion?.stop(true);
    await gw?.close();
  });

  async function open(path: string, width: number, dark: boolean): Promise<{ context: BrowserContext; page: Page }> {
    const phone = width < 500;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1, colorScheme: dark ? "dark" : "light" });
    context.setDefaultTimeout(15_000);
    // Real responses through Playwright's client (Chromium aborts loopback requests when Docker changes interfaces).
    await context.route("**/*", async (route) => {
      if (route.request().headers()["accept"]?.includes("text/event-stream")) return route.continue();
      await route.fulfill({ response: await route.fetch() });
    });
    // HMR is irrelevant here (the sources stay fixed); keep its handshake local.
    await context.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => socket.send(JSON.stringify({ type: "connected" })));
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("ERR_NETWORK_CHANGED")) problems.push(message.text()); });
    await page.goto(`${base}${path}`);
    return { context, page };
  }
  // Entrances and the drawer finish first (the longest motion token is 500 ms).
  const shot = async (page: Page, name: string) => { await page.waitForTimeout(600); await page.screenshot({ path: resolve(shots, `${name}.png`) }); };
  const log = (page: Page) => page.getByRole("log", { name: "Conversation" });
  const shown = (locator: Locator) => locator.waitFor({ state: "visible" });
  const gone = (locator: Locator) => locator.first().waitFor({ state: "detached" });
  const documentFits = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight);

  test("a conversation reads like a messenger: markers, cards, a friendly failure with Retry and a live status", async () => {
    const { context, page } = await open(`/bots/${id.kropek}`, 1440, false);
    try {
      await shown(log(page).getByText("FIXme CRM mówi,"));
      // The other bot is a chip, the exchange a marker that opens it.
      // Kropek wrote to FIXme CRM, answered you, then heard back: two markers around its bubble.
      expect(await log(page).getByRole("link", { name: "FIXme CRM" }).count()).toBe(2);
      expect((await log(page).locator("p", { has: page.getByRole("link", { name: "FIXme CRM" }) }).allTextContents()).map((t) => t.replace(/\s+/g, " ").trim())).toEqual(["Messaged FIXme CRM", "Message from FIXme CRM"]);
      expect(await documentFits(page)).toBe(true);

      // Enter sends; the message is there at once and the question card arrives.
      const box = page.getByRole("textbox", { name: "Message" });
      expect(await box.getAttribute("placeholder")).toBe("Message Kropek");
      await box.fill("Przygotuj notatkę do Notion");
      await box.press("Enter");
      expect(await box.inputValue()).toBe("");
      await shown(log(page).getByText("Przygotuj notatkę do Notion"));
      const question = page.getByRole("region", { name: "Do której bazy Notion zapisać notatkę?" });
      await shown(question);
      await shot(page, "cards-question-desktop-light");
      await question.getByRole("button", { name: /Klienci/ }).click();

      // The approval card: preview, Edit in place, send your version back.
      const approval = page.locator("section", { hasText: "Needs approval" });
      await shown(approval.getByRole("button", { name: "Approve" }));
      await shot(page, "cards-approval-desktop-light");
      await approval.getByRole("button", { name: "Edit" }).click();
      const edit = approval.getByRole("textbox", { name: "Your version" });
      await edit.fill("ACME: 2 zgłoszenia, telefon w piątek.");
      await approval.getByRole("button", { name: "Send edits" }).click();
      await shown(log(page).getByText("Jasne, zapiszę Twoją wersję:"));
      await shown(approval.getByText("Sent back with your edits"));

      // A failed reply is a friendly line; the technical cause stays out of the text. Retry runs it again.
      await box.fill("Spróbuj jeszcze raz, proszę.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await shown(log(page).getByText("Kropek couldn't reply — the model isn't available."));
      await gone(log(page).getByText("Model endpoint returned HTTP 400", { exact: true }));
      await shot(page, "error-desktop-light");
      failing = false;
      await log(page).getByRole("button", { name: "Retry" }).click();
      await shown(log(page).getByText("Teraz działa — model odpowiada."));
      await gone(log(page).getByText("couldn't reply"));

      // While the bot searches Notion, its avatar and a status line sit under its last message.
      await box.fill("Co mamy w Notion o ACME?");
      await box.press("Enter");
      const status = log(page).getByRole("status").filter({ hasText: "Searching Notion" });
      await shown(status);
      await gone(page.getByRole("banner").getByText("Searching Notion"));
      // Following: the status line is in view at the bottom.
      expect(await log(page).evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(80);
      await shot(page, "status-desktop-light");
      releaseSearch.resolve();
      await shown(log(page).getByText("Faktury 2026"));
      await gone(status);

      // Scrolled up, new messages do not pull you down; the button does.
      await log(page).evaluate((n) => (n.scrollTop = 0));
      const jump = page.getByRole("button", { name: "Jump to the latest message" });
      await shown(jump);
      await jump.click();
      await gone(jump);
      expect(await documentFits(page)).toBe(true);
    } finally { await context.close(); }
  }, 120_000);

  test("the bot ⇄ bot exchange opens as its own chat and Close chat returns", async () => {
    const { context, page } = await open(`/bots/${id.kropek}`, 1440, false);
    try {
      await log(page).getByRole("link", { name: "FIXme CRM" }).first().click();
      await page.waitForURL(/\/exchanges\//);
      expect(await page.getByRole("heading", { level: 1 }).textContent()).toMatch(/Kropek.*FIXme CRM/s);
      await shown(log(page).getByText("Jaki jest status klienta ACME?"));
      await shown(log(page).getByText("ostatni kontakt wczoraj"));
      await shot(page, "exchange-desktop-light");
      await page.getByRole("button", { name: "Close chat" }).click();
      await page.waitForURL(new RegExp(`/bots/${id.kropek}$`));
    } finally { await context.close(); }
  }, 60_000);

  test("light and dark, desktop and phone", async () => {
    for (const dark of [false, true]) for (const width of [1440, 390]) {
      const name = `${width === 390 ? "phone" : "desktop"}-${dark ? "dark" : "light"}`;
      const { context, page } = await open(`/bots/${id.kropek}`, width, dark);
      try {
        await shown(log(page).getByText("Faktury 2026"));
        expect(await documentFits(page)).toBe(true);
        await shot(page, `chat-${name}`);
        await log(page).evaluate((n) => (n.scrollTop = 0));
        await shot(page, `chat-top-${name}`);
        await log(page).getByRole("link", { name: "FIXme CRM" }).first().click();
        await shown(log(page).getByText("Jaki jest status klienta ACME?"));
        await shot(page, `exchange-${name}`);
        if (width === 390) await page.getByRole("button", { name: "Open menu" }).click();
        await shown(page.getByRole("link", { name: /Kropek/ }).first());
        await shot(page, `sidebar-${name}`);
      } finally { await context.close(); }
    }
    expect(problems).toEqual([]);
  }, 180_000);
});
