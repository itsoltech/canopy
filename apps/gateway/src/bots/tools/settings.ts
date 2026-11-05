import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Invalid } from "../../store/store.ts";
import { define, json, message, object, str } from "./shared.ts";

const defaults = object({
  workspaceId: str,
  provider: { type: "string", enum: ["PROVIDER_UNSPECIFIED", "PROVIDER_CLAUDE", "PROVIDER_CODEX", "PROVIDER_GROK"] },
  providerProfileId: str,
  // No PERMISSION_MODE_FULL_ACCESS: bots never choose it, the user picks it in the app.
  permissionMode: {
    type: "string",
    enum: [
      "PERMISSION_MODE_UNSPECIFIED",
      "PERMISSION_MODE_ASK",
      "PERMISSION_MODE_READ_ONLY",
      "PERMISSION_MODE_ACCEPT_EDITS",
      "PERMISSION_MODE_FULL_AUTO",
    ],
  },
  models: {
    type: "array",
    maxItems: 3,
    items: object(
      { provider: { type: "string", enum: ["PROVIDER_CLAUDE", "PROVIDER_CODEX", "PROVIDER_GROK"] }, model: str },
      ["provider", "model"],
    ),
  },
});

const textGeneration = object({
  provider: { type: "string", enum: ["PROVIDER_UNSPECIFIED", "PROVIDER_CLAUDE", "PROVIDER_CODEX", "PROVIDER_GROK"] },
  profileId: str,
  model: str,
  effort: str,
  threadTitleInstructions: str,
});

export const settingsTools = [
  define(
    "get_settings",
    "Settings: read user and project thread defaults and user text generation settings with versions. Appearance is excluded. Nested settings use protobuf JSON field names and enum names (e.g. provider=PROVIDER_CODEX).",
    object({}),
    "Checking settings",
    async ({ core }) => {
      const s = await core.settings();

      return {
        user: {
          version: String(s.user?.version ?? 0),
          threadDefaults: s.user?.threadDefaults && json(ui.ThreadDefaultsSchema, s.user.threadDefaults),
          textGeneration: s.user?.textGeneration && json(ui.TextGenerationSettingsSchema, s.user.textGeneration),
        },
        projects: s.projects.map((p) => json(ui.ProjectSettingsSchema, p)),
      };
    },
    "read",
  ),
  define(
    "update_settings",
    "Settings: replace supplied thread_defaults and/or text_generation sections (nested protobuf JSON, same as get_settings). Omitted sections stay unchanged; omitted fields within a supplied section reset. expected_version from get_settings is required. Supplying thread_defaults requires approval because it can change permissions; text_generation alone follows your approval policy. Appearance and secrets cannot be changed.",
    object({ expected_version: str, thread_defaults: defaults, text_generation: textGeneration }, ["expected_version"]),
    "Updating settings",
    ({ core, string, args, action }) =>
      action(async () => {
        if (!args["thread_defaults"] && !args["text_generation"])
          throw new Invalid("provide thread_defaults or text_generation");

        const result = await core.updateUserSettings(
          create(ui.UpdateUserSettingsRequestSchema, {
            expectedVersion: version(string("expected_version")),
            ...(args["thread_defaults"] !== undefined && {
              threadDefaults: message(ui.ThreadDefaultsSchema, args["thread_defaults"]),
            }),
            ...(args["text_generation"] !== undefined && {
              textGeneration: message(ui.TextGenerationSettingsSchema, args["text_generation"]),
            }),
          }),
        );

        return {
          version: String(result.version),
          threadDefaults: result.threadDefaults && json(ui.ThreadDefaultsSchema, result.threadDefaults),
          textGeneration: result.textGeneration && json(ui.TextGenerationSettingsSchema, result.textGeneration),
        };
      }),
  ),
  define(
    "set_project_defaults",
    "Projects: replace project thread defaults (nested protobuf JSON as in get_settings). expected_version is the project's settings version, or 0 if no saved settings. Can change default provider/model/workspace/permissions; requires approval. No agent template field exists in the UI.",
    object({ project_id: str, expected_version: str, thread_defaults: defaults }, [
      "project_id",
      "expected_version",
      "thread_defaults",
    ]),
    "Updating project defaults",
    ({ core, string, args, action }) =>
      action(async () =>
        json(
          ui.ProjectSettingsSchema,
          await core.updateProjectSettings(
            create(ui.UpdateProjectSettingsRequestSchema, {
              projectId: string("project_id"),
              expectedVersion: version(string("expected_version")),
              threadDefaults: message(ui.ThreadDefaultsSchema, args["thread_defaults"]),
            }),
          ),
        ),
      ),
    "approval",
  ),
];

function version(value: string): bigint {
  if (!/^\d{1,19}$/.test(value))
    throw new Invalid("expected_version must be a nonnegative integer string from get_settings");

  return BigInt(value);
}
