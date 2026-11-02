/** Seeded Bots data for the browser checks: three bots, one conversation with every kind of entry. */
import { create, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots, Provider } from "@open-agents/contracts";

export const ids = {
  kropek: "01a19c85-feb9-7330-a388-002a7c4582d5",
  crm: "01a19c85-1111-7330-a388-002a7c4582d5",
  grok: "01a19c85-2222-7330-a388-002a7c4582d5",
  exchange: "01a19c85-3333-7330-a388-002a7c4582d5",
};

const bot = (id: string, name: string, shape: string, color: string, model: string) =>
  create(bots.BotSchema, { id, configuration: { name, shape, color, provider: Provider.CLAUDE, providerInstance: "cliproxyapi", model, approvalPolicy: "safe" } });

export function seed(now = Date.now()) {
  const at = (minutes: number) => timestampFromDate(new Date(now - minutes * 60_000));
  const kropek = bot(ids.kropek, "Kropek", "round", "#f97316", "claude-opus-5-5");
  const crm = bot(ids.crm, "FIXme CRM", "ghost", "#8b5cf6", "claude-sonnet-5-5");
  const grok = bot(ids.grok, "Grok Bot", "blob", "#0ea5e9", "claude-opus-5-5");
  let seq = 0n;
  const m = (minutes: number, senderId: string, text: string, extra: Partial<bots.BotMessage> = {}) =>
    create(bots.BotMessageSchema, { id: `m${++seq}`, seq, botId: ids.kropek, senderId, recipientId: senderId === "user" ? ids.kropek : "user", kind: "message", text, createdAt: at(minutes), ...extra });
  const messages = [
    m(26 * 60, "user", "Hej! Czym się zajmujesz?"),
    m(26 * 60 - 1, ids.kropek, "Pomagam Ci z projektami: sprawdzam wątki, uruchamiam agentów i rozmawiam z innymi botami, np. z FIXme CRM."),
    m(95, "user", "widzisz jakieś wątki w projekcie stack-worker?"),
    m(94, ids.kropek, "Tak — w projekcie **test** widzę **40 wątków**. Wszystkie mają status `idle`.\n\nPrzykładowe tytuły:\n\n- „Testowe użycie kilku narzędzi”\n- „Komendy systemowe i podsumowanie wyników”\n- „Uruchomienie pętli z 300 krokami w tle”\n\nChcesz, żebym zajrzał do któregoś z nich?"),
    m(93, ids.kropek, "Mogę też zapytać FIXme CRM o klientów, których dotyczą."),
    m(40, "user", "Zapytaj FIXme CRM o status klienta ACME."),
    m(39, ids.kropek, `Messaged FIXme CRM`, { kind: "event", recipientId: ids.crm, exchangeId: ids.exchange }),
    m(38, ids.crm, "Message from FIXme CRM: ACME ma otwarte 2 zgłoszenia, ostatni kontakt wczoraj.", { kind: "event", recipientId: ids.kropek, exchangeId: ids.exchange }),
    m(37, ids.kropek, "FIXme CRM mówi, że **ACME** ma 2 otwarte zgłoszenia, a ostatni kontakt był wczoraj. Przygotować notatkę do Notion?"),
    m(12, "user", "Tak, i wyślij ją do Notion."),
    m(11, ids.kropek, "Model endpoint returned HTTP 400", { kind: "event", failed: true }),
    m(6, "user", "Spróbuj jeszcze raz, proszę."),
  ];
  const approvals = [
    create(bots.BotApprovalSchema, { id: "a1", botId: ids.kropek, kind: "question", prompt: "Do której bazy Notion zapisać notatkę?", options: ["Klienci", "Spotkania", "Notatki zespołu"], status: "pending", createdAt: at(5) }),
    create(bots.BotApprovalSchema, { id: "a2", botId: ids.kropek, kind: "approval", prompt: "Needs approval · Sending to Notion\nAction: Create page\nDatabase: Klienci\nText: ACME — 2 otwarte zgłoszenia (wsparcie, faktura). Ostatni kontakt: wczoraj. Następny krok: telefon do opiekuna w piątek.", status: "pending", createdAt: at(4) }),
  ];
  const conversation = (statusLine: string, working: boolean, failedLast: boolean) => create(bots.BotConversationSchema, failedLast
    ? { bot: kropek, messages: messages.slice(0, -1), approvals: [], statusLine: "", working: false, revision: 1n }
    : { bot: kropek, messages, approvals, statusLine, working, revision: 1n });
  const list = [kropek, crm, grok].map((b) => create(bots.BotSchema, { ...b, lastMessage: b.id === ids.kropek ? messages.at(-1) : create(bots.BotMessageSchema, { senderId: b.id, text: b.id === ids.crm ? "Klient **ACME**: 2 zgłoszenia" : "Gotowe — sprawdź `wynik`.", createdAt: at(b.id === ids.crm ? 38 : 300) }) }));
  const exchange = [
    create(bots.BotMessageSchema, { id: "x1", botId: ids.crm, senderId: ids.kropek, recipientId: ids.crm, kind: "event", text: "Message from Kropek: Jaki jest status klienta ACME?", exchangeId: ids.exchange, createdAt: at(39) }),
    create(bots.BotMessageSchema, { id: "x2", botId: ids.crm, senderId: ids.crm, recipientId: ids.kropek, kind: "message", text: "ACME ma otwarte **2 zgłoszenia** (wsparcie, faktura), ostatni kontakt wczoraj.", exchangeId: ids.exchange, createdAt: at(38) }),
    create(bots.BotMessageSchema, { id: "x3", botId: ids.crm, senderId: ids.kropek, recipientId: ids.crm, kind: "event", text: "Message from Kropek: Dzięki! Kto jest opiekunem?", exchangeId: ids.exchange, createdAt: at(38) }),
    create(bots.BotMessageSchema, { id: "x4", botId: ids.crm, senderId: ids.crm, recipientId: ids.kropek, kind: "message", text: "Opiekunem jest Anna z zespołu sprzedaży.", exchangeId: ids.exchange, createdAt: at(37) }),
  ];
  return {
    list: toJson(bots.ListBotsResponseSchema, create(bots.ListBotsResponseSchema, { bots: list })) as JsonValue,
    bot: (id: string) => toJson(bots.GetBotResponseSchema, create(bots.GetBotResponseSchema, { bot: list.find((b) => b.id === id) })) as JsonValue,
    conversation: (statusLine = "Checking Notion", working = true, failedLast = false) => toJson(bots.BotConversationSchema, conversation(statusLine, working, failedLast)) as JsonValue,
    exchange: toJson(bots.ReadBotExchangeResponseSchema, create(bots.ReadBotExchangeResponseSchema, { messages: exchange })) as JsonValue,
  };
}
