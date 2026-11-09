import { create, fromJson, toJson, type DescMessage, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { Predicate, Schema } from "effect";

export type SettingsJson = Record<string, JsonValue>;

const object = Schema.is(Schema.Record(Schema.String, Schema.MutableJson));
const readObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const LOCAL_APPEARANCE = new Set(["sidebarWidth", "sidebarCollapsed", "threadPanelCollapsed"]);

export const DEVICE_SETTINGS_FIELDS = new Set([
  "sidebar.archivedExpanded",
  ...[...LOCAL_APPEARANCE].map((key) => `appearance.${key}`),
]);

const SECTIONS = {
  appearance: ui.AppearanceSettingsSchema,
  threadDefaults: ui.ThreadDefaultsSchema,
  general: ui.GeneralSettingsSchema,
  composer: ui.ComposerSettingsSchema,
  textGeneration: ui.TextGenerationSettingsSchema,
  sidebar: ui.SidebarSettingsSchema,
  cliUpdates: ui.CliUpdateSettingsSchema,
} satisfies Record<string, DescMessage>;

const PINS = new Set(["sidebar.pinnedThreadIds", "sidebar.pinnedBotIds"]);

export function flatten(value: SettingsJson, prefix = "") {
  const result: SettingsJson = {};

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (object(child)) Object.assign(result, flatten(child, path));
    else result[path] = child;
  }

  return result;
}

export function settingsValues(stored: SettingsJson, self: string, nodes: readonly string[] = []) {
  const result = {
    ...readObject({
      timezone: stored["timezone"] ?? "",
      "general.confirmDelete": null,
      "cliUpdates.intervalMinutes": null,
    }),
  };

  for (const [section, schema] of Object.entries(SECTIONS)) {
    const message = fromJson(schema, stored[section] ?? {}, { ignoreUnknownFields: true });
    const json = { ...readObject(toJson(schema, message, { alwaysEmitImplicit: true })) };

    if (section === "appearance") for (const key of LOCAL_APPEARANCE) delete json[key];

    if (section === "threadDefaults") delete json["workspaceId"];

    if (section === "sidebar") {
      delete json["archived"];
      delete json["archivedExpanded"];
    }

    Object.assign(result, flatten(json, section));
  }

  for (const field of PINS) {
    result[field] = strings(result[field] ?? []).map((value) => {
      const { id, node } = splitId(value);

      return `${id}@${node ? ([self, ...nodes].find((full) => nodeRef(full) === node) ?? node) : self}`;
    });
  }

  return result;
}

/** Apply known leaves only. Future fields remain in config_items and survive local writes. */
export function materializeSettings(stored: SettingsJson, values: SettingsJson, self: string): SettingsJson {
  const next = structuredClone(stored);
  const supported = settingsValues({}, self);
  supported["general.confirmDelete"] = null;
  supported["cliUpdates.intervalMinutes"] = null;

  for (const [field, value] of Object.entries(values)) {
    if (!(field in supported)) continue;
    const path = field.split(".");
    let target = next;

    for (const key of path.slice(0, -1)) {
      if (!object(target[key])) target[key] = {};
      const child = target[key];

      if (object(child)) target = child;
    }

    const key = path.at(-1)!;

    if (value === null) delete target[key];
    else if (PINS.has(field))
      target[key] = strings(value).map((ref) => {
        const [id, home] = ref.split("@");

        return !home || home === nodeRef(self) || home === self ? id! : `${id}~${nodeRef(home)}`;
      });
    else target[key] = value;
  }

  return next;
}

export function settingsRequest(stored: SettingsJson, version: bigint) {
  // Unknown fields stay in config_items. Known fields with future values must not silently become defaults.
  for (const [section, schema] of Object.entries(SECTIONS)) fromJson(schema, stored[section] ?? {});
  const user = fromJson(ui.UserSettingsSchema, stored, { ignoreUnknownFields: true });

  return create(ui.UpdateUserSettingsRequestSchema, {
    expectedVersion: version,
    appearance: user.appearance,
    threadDefaults: user.threadDefaults,
    general: user.general,
    composer: user.composer,
    sidebar: user.sidebar,
    textGeneration: user.textGeneration,
    cliUpdates: user.cliUpdates,
    ...(user.timezone && { timezone: user.timezone }),
  });
}

const INSTANCE_REFS = [
  ["threadDefaults.provider", "threadDefaults.providerProfileId"],
  ["textGeneration.provider", "textGeneration.profileId"],
] as const;

/** Instance references of the settings record are global ids (aliases.ts); each computer stores its own. */
export function mapSettingsInstances(values: SettingsJson, map: (harness: string, id: string) => string) {
  const next = { ...values };

  for (const [provider, profile] of INSTANCE_REFS) {
    const harness = String(next[provider] ?? "")
      .replace(/^PROVIDER_/, "")
      .toLowerCase();

    const id = next[profile];

    if (Predicate.isString(id) && id && harness && harness !== "unspecified") next[profile] = map(harness, id);
  }

  return next;
}
