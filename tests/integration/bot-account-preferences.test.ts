import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui, type bots } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";
import { colorSchemePreference, threadWidthPreference, type JsonObject } from "@canopy/domain";
import { preferenceNavigation } from "../../apps/gateway/src/bots/tools/account-preferences.ts";

const color = "appearance.color_scheme";
const width = "appearance.thread_width";
const search = "search_canopy_preferences";
const get = "get_canopy_preference";
const set = "set_canopy_preference";

function result(chat: bots.BotConversation) {
  const reply = JSON.parse(chat.messages.at(-1)!.text.replace(/^TOOL_RESULT:/, ""));

  return JSON.parse(reply.result.content[0].text);
}

test("preference paths require matching client evidence and include control visibility", () => {
  const version = "0.90.0-nightly.5";

  expect(preferenceNavigation(colorSchemePreference, { client: "desktop", client_version: version }, version)).toEqual({
    status: "confirmed",
    path: ["Settings", "Appearance", "Colors", "Color scheme"],
  });
  expect(preferenceNavigation(threadWidthPreference, { client: "ios", client_version: version }, version)).toEqual({
    status: "conditional",
    path: ["Settings", "Appearance", "Interface", "Thread width"],
    conditions: ["The Threads module must be enabled."],
  });
  expect(
    preferenceNavigation(colorSchemePreference, { client: "android", client_version: "0.89.0" }, version),
  ).not.toHaveProperty("path");
});

describe.skipIf(!dockerAvailable)("Canopy account preferences through private bot chat", () => {
  let f: HarnessBots;
  let botId: string;

  beforeAll(async () => {
    f = await harnessBots();
    botId = (await f.add(Provider.CODEX, f.workerId, "full_auto")).id;
  }, 30_000);

  afterAll(async () => {
    await f?.close();
  });

  const settings = async () => (await f.gw.api.getSettings({})).user!;

  const invoke = async (name: string, args: JsonObject) => {
    await f.tool(botId, name, args);

    return result(await f.settled(botId));
  };

  const pending = async () => {
    const chat = await eventually(
      () => f.read(botId),
      (r) => r.approvals.some((a) => a.status === "pending"),
    );

    return chat.approvals.find((a) => a.status === "pending")!;
  };

  test("search is bounded and details preserve uncertainty about client navigation", async () => {
    expect(await invoke(search, { query: "colour dark" })).toMatchObject({
      matches: [{ id: color, label: "Color scheme" }],
      truncated: false,
    });

    expect(await invoke(search, { query: "appearance", limit: 1 })).toMatchObject({
      matches: [{ id: color }],
      truncated: true,
    });

    const bounded = await invoke(search, { query: "appearance", limit: Number.MAX_SAFE_INTEGER });
    expect(bounded.matches).toHaveLength(2);
    expect(JSON.stringify(bounded).length).toBeLessThan(700);
    expect(await invoke(search, { query: "x".repeat(161) })).toMatchObject({ error: expect.stringContaining("160") });

    const details = await invoke(get, { setting_id: color, client: "android", client_version: "0.0.0-dev" });

    expect(details).toMatchObject({
      id: color,
      type: "enum",
      clients: ["web", "desktop", "ios", "android"],
      readable: true,
      writable: true,
      confirmation: "always",
      choices: [
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
      value: "system",
      version: String((await settings()).version),
      navigation: { status: "unconfirmed", reason: expect.stringContaining("does not identify") },
    });
    expect(details.navigation).not.toHaveProperty("path");
    expect(JSON.stringify(details).length).toBeLessThan(1200);
    expect((await f.read(botId)).approvals).toHaveLength(0);
  }, 15_000);

  test("unknown, protected, and device-local keys are refused without a card", async () => {
    const current = await settings();

    for (const id of ["unknown", "thread_defaults.permission_mode", "appearance.contrast"]) {
      expect(await invoke(get, { setting_id: id })).toEqual({
        error: "Unknown or unsupported Canopy preference.",
      });
      expect(await invoke(set, { setting_id: id, value: "dark", expected_version: String(current.version) })).toEqual({
        error: "Unknown or unsupported Canopy preference.",
      });
    }

    expect(await invoke(set, { setting_id: width, value: "dark", expected_version: String(current.version) })).toEqual({
      error: "Choose a value listed by get_canopy_preference.",
    });
    expect((await f.read(botId)).approvals).toHaveLength(0);
    expect((await settings()).version).toBe(current.version);
  }, 20_000);

  test("full auto still requires one-shot approval and changes only one field", async () => {
    const { settings: before } = await f.gw.api.updateUserSettings({
      expectedVersion: (await settings()).version,
      appearance: {
        colorScheme: ui.ColorScheme.LIGHT,
        chatWidth: ui.ChatWidth.WIDE,
        lightTheme: ui.ColorTheme.FERN,
        darkTheme: ui.ColorTheme.ASH,
        sidebarWidth: 310,
      },
      timezone: "Europe/Warsaw",
    });

    await f.tool(botId, set, { setting_id: color, value: "dark", expected_version: String(before!.version) });
    const card = await pending();
    expect(card.prompt).toContain("“Color scheme” to “Dark”");
    expect(card.ruleOptions).toHaveLength(0);
    expect((await settings()).version).toBe(before!.version);

    await f.gw.api.answerBotApproval({ approvalId: card.id, approve: true });
    expect(result(await f.settled(botId))).toEqual({
      status: "saved",
      id: color,
      value: "dark",
      version: String(before!.version + 1n),
    });

    const after = await settings();
    expect(after.appearance).toEqual({ ...before!.appearance!, colorScheme: ui.ColorScheme.DARK });
    expect(after.timezone).toBe(before!.timezone);
    expect(after.threadDefaults).toEqual(before!.threadDefaults);
  }, 15_000);

  test("denial and a concurrent UI save leave the proposed change unapplied", async () => {
    const before = await settings();
    const args = { setting_id: color, value: "system", expected_version: String(before.version) };

    await f.tool(botId, set, args);
    await f.gw.api.answerBotApproval({ approvalId: (await pending()).id, approve: false });
    expect(result(await f.settled(botId))).toMatchObject({ status: "discarded" });
    expect((await settings()).version).toBe(before.version);

    await f.tool(botId, set, args);
    const card = await pending();

    const { settings: concurrent } = await f.gw.api.updateUserSettings({
      expectedVersion: before.version,
      timezone: "UTC",
    });

    await f.gw.api.answerBotApproval({ approvalId: card.id, approve: true });

    expect(result(await f.settled(botId))).toMatchObject({ error: expect.stringContaining("changed elsewhere") });
    expect(await settings()).toEqual(concurrent!);
  }, 15_000);
});
