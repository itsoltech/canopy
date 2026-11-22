import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  appearanceChoiceKey,
  isJsonArray,
  colorSchemePreference,
  threadWidthPreference,
  SETTINGS_CLIENTS,
  type SettingsGuideArgs,
} from "@canopy/domain";
import { settingsSearchWords } from "@canopy/ui/settings";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "../../core/core-context.ts";
import { coreSettings } from "../../core/core-settings.ts";
import { findCanopySettings } from "../../core/settings-guide.ts";
import { Invalid } from "../../store/errors.ts";
import { SettingsConflict, type AppearancePreferencePatch } from "../../store/settings.ts";
import { requireOwnerBotTurn } from "../owner-turn.ts";
import { define, object, settingsVersion, str, type PlatformTool, type ToolContext } from "./shared.ts";

const catalogue = [colorSchemePreference, threadWidthPreference];

type Setting = (typeof catalogue)[number];

const MAX_MATCHES = 5;

async function ownerTurn(c: ToolContext, needsApproval = false) {
  const { core, options, turn, call } = c;

  await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* requireOwnerBotTurn(sql, options.userId, turn, "Canopy preferences require a private owner message.");

      if (needsApproval) {
        const approved = yield* sql`SELECT 1 FROM bot_approvals
          WHERE id = ${call.id}::uuid AND turn_id = ${turn.id}::uuid AND bot_id = ${turn.bot_id}::uuid
            AND kind = 'approval' AND status = 'approved' AND allowed_by_rule IS NULL AND answered_at IS NOT NULL`;

        if (!approved.length) return yield* Effect.fail(new Invalid("This preference change needs your approval."));
      }
    }),
  );
}

function settingById(c: ToolContext): Setting {
  const id = c.string("setting_id", 80);
  const setting = catalogue.find((entry) => entry.id === id);

  if (!setting) throw new Invalid("Unknown or unsupported Canopy preference.");

  return setting;
}

const userSettings = (c: ToolContext) => coreSettings(c.core, (s) => s.user(c.options.userId));

function currentValue(setting: Setting, settings: ui.UserSettings) {
  return setting.field === "colorScheme"
    ? appearanceChoiceKey(setting.choices, settings.appearance?.colorScheme, setting.defaultChoice)
    : appearanceChoiceKey(setting.choices, settings.appearance?.chatWidth, setting.defaultChoice);
}

export function preferenceNavigation(setting: Setting, args: Omit<SettingsGuideArgs, "query">, version?: string) {
  const section = findCanopySettings({ ...args, query: "Appearance" }, version);

  const sectionPath = section["path"];

  if (section["status"] !== "confirmed_section" || !isJsonArray(sectionPath)) return section;

  const path = [...sectionPath, setting.group, setting.label];

  return setting.field === "chatWidth"
    ? { status: "conditional", path, conditions: ["The Threads module must be enabled."] }
    : { status: "confirmed", path };
}

function allowedChoice<T>(choices: Record<string, { label: string; value: T }>, key: string) {
  const choice = Object.hasOwn(choices, key) ? choices[key] : undefined;

  if (!choice) throw new Invalid("Choose a value listed by get_canopy_preference.");

  return choice;
}

function requestedChange(c: ToolContext) {
  const setting = settingById(c);
  const value = c.string("value", 80);
  const expectedVersion = settingsVersion(c.string("expected_version", 19), "get_canopy_preference");

  return { setting, value, expectedVersion };
}

function preferencePatch(setting: Setting, value: string): AppearancePreferencePatch {
  return setting.field === "colorScheme"
    ? { colorScheme: allowedChoice(setting.choices, value).value }
    : { chatWidth: allowedChoice(setting.choices, value).value };
}

const setPreference: PlatformTool = {
  ...define(
    "set_canopy_preference",
    "Change a legacy appearance default on explicit owner request. This affects older clients and the initial import on clients without saved appearance. Use the value and version from get_canopy_preference. Always asks for approval.",
    object({ setting_id: str, value: str, expected_version: str }, ["setting_id", "value", "expected_version"]),
    "Updating a Canopy preference",
    (c) =>
      c.action(async () => {
        await ownerTurn(c, true);
        const { setting, value, expectedVersion } = requestedChange(c);
        const appearancePreference = preferencePatch(setting, value);

        const saved = await c.core.updateUserSettings(create(ui.UpdateUserSettingsRequestSchema, { expectedVersion }), {
          appearancePreference,
        });

        return { status: "saved", id: setting.id, value: currentValue(setting, saved), version: String(saved.version) };
      }),
    "approval",
  ),
  async prepare(c) {
    // Keep an existing card actionable. The write checks the version after the owner's decision.
    if (c.call.has_approval) return undefined;
    await ownerTurn(c);
    const { setting, value, expectedVersion } = requestedChange(c);
    const { label } = allowedChoice<number>(setting.choices, value);

    if ((await userSettings(c)).version !== expectedVersion)
      throw new SettingsConflict("Settings changed elsewhere. Read the preference again before proposing a change.");

    return {
      prompt: `Change the legacy default for “${setting.label}” to “${label}”?\nOlder clients and clients importing appearance for the first time use this default.`,
    };
  },
};

export const accountPreferenceTools = [
  define(
    "search_canopy_preferences",
    "Find appearance controls by keyword in a private owner turn. Use get_canopy_preference for navigation and legacy defaults.",
    object({ query: str, limit: { type: "integer", minimum: 1 } }, ["query"]),
    "Searching Canopy preferences",
    async (c) => {
      await ownerTurn(c);
      const words = settingsSearchWords(c.string("query", 160));
      const limit = Math.min(c.integer("limit") ?? MAX_MATCHES, MAX_MATCHES);

      if (!words.length) return { matches: [], truncated: false };

      const matches = catalogue.filter((setting) => {
        const text = `${setting.id} ${setting.label} ${setting.keywords}`.toLowerCase();

        return words.every((word) => text.includes(word));
      });

      return {
        matches: matches.slice(0, limit).map(({ id, label, description }) => ({ id, label, description })),
        truncated: matches.length > limit,
      };
    },
    "read",
  ),
  define(
    "get_canopy_preference",
    "Read a legacy appearance default by search result ID. For a verified path to the device setting, supply the user's client and exact app version. Device-local values are unavailable to this tool.",
    object({ setting_id: str, client: { type: "string", enum: [...SETTINGS_CLIENTS] }, client_version: str }, [
      "setting_id",
    ]),
    "Checking a Canopy preference",
    async (c) => {
      await ownerTurn(c);
      const setting = settingById(c);
      const saved = await userSettings(c);
      const client = SETTINGS_CLIENTS.find((name) => name === c.args["client"]);
      const clientVersion = c.args["client_version"] === undefined ? undefined : c.string("client_version", 80);

      return {
        id: setting.id,
        label: setting.label,
        description: setting.description,
        scope: "legacy appearance default on this gateway",
        clients: [...SETTINGS_CLIENTS],
        type: "enum",
        choices: Object.entries(setting.choices).map(([value, { label }]) => ({ value, label })),
        value: currentValue(setting, saved),
        version: String(saved.version),
        readable: true,
        writable: true,
        confirmation: "always",
        navigation: preferenceNavigation(setting, {
          ...(client && { client }),
          ...(clientVersion && { client_version: clientVersion }),
        }),
      };
    },
    "read",
  ),
  setPreference,
];
