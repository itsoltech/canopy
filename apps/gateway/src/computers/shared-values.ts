import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { Predicate, Schema } from "effect";

import { computerLink as link, ProviderProfileKind, ui } from "@canopy/contracts";

import { type SharedKey } from "@canopy/domain/computers";

import { randomBytes } from "node:crypto";

import { isRef, providerOf, type InstanceRow, type StoredEnvVar } from "../store/instance-config.ts";

import { decryptSecret } from "../store/secrets.ts";

import { envValues, failure, payloadObject, type Outcome, type Payload, type Value } from "./shared-context.ts";
import { sharedLocal } from "./shared-persistence.ts";
import type { SharedConfig } from "./shared.ts";

/** Writes a peer's value through this computer's own handlers. Returns the local secret tokens. */
export async function sharedWrite(
  hostContext: SharedConfig,
  key: SharedKey,
  payload: Payload,
  secrets: Map<string, string>,
  current: Value | undefined,
): Promise<Outcome & { tokens?: Record<string, string> }> {
  try {
    if (key.kind === "instance") {
      return await writeInstance(hostContext, key, payload, secrets, current);
    }

    if (key.kind === "models") {
      if (!current) return { outcome: "rejected", message: "the instance is not on this computer" };
      await sharedLocal(
        hostContext,
        "SetInstanceModels",
        create(ui.SetInstanceModelsRequestSchema, {
          harness: providerOf(key.harness),
          id: key.id,
          models: {
            favorites: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(payload["favorites"])],
            hidden: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(payload["hidden"])],
            shown: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(payload["shown"])],
            custom: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(payload["custom"])],
          },
        }),
      );

      return { outcome: "applied", tokens: {} };
    }

    if (key.kind === "project") {
      const row = (
        await hostContext.store.query<{ name: string; kind: string; archived_at: Date | null }>(
          "SELECT name,kind,archived_at FROM projects WHERE id=$1::uuid AND owner_user_id=$2::uuid",
          [key.id, hostContext.store.owner],
        )
      )[0];

      if (!row) await hostContext.host.createProject(key.id, String(payload["name"]));
      else if (row.kind !== "project" || row.archived_at)
        return { outcome: "rejected", message: "the project is archived on this computer" };
      else if (row.name !== payload["name"])
        await sharedLocal(
          hostContext,
          "RenameProject",
          create(ui.RenameProjectRequestSchema, { projectId: key.id, name: String(payload["name"]) }),
        );

      return { outcome: "applied", tokens: {} };
    }

    if (key.kind !== "settings") return { outcome: "rejected", message: "unknown item" };

    for (let attempt = 0; ; attempt++) {
      const user =
        (await sharedLocal<ui.GetSettingsResponse>(hostContext, "GetSettings", create(ui.GetSettingsRequestSchema)))
          .user ?? create(ui.UserSettingsSchema);

      const request = create(ui.UpdateUserSettingsRequestSchema, { expectedVersion: user.version });

      if (key.section === "appearance") {
        const a = fromJson(ui.AppearanceSettingsSchema, payload, { ignoreUnknownFields: true });
        request.appearance = clone(ui.AppearanceSettingsSchema, user.appearance ?? create(ui.AppearanceSettingsSchema));
        Object.assign(request.appearance, {
          colorScheme: a.colorScheme,
          accent: a.accent,
          lightTheme: a.lightTheme,
          darkTheme: a.darkTheme,
          chatWidth: a.chatWidth,
        });
      } else if (key.section === "thread_defaults") {
        request.threadDefaults = fromJson(ui.ThreadDefaultsSchema, payload, { ignoreUnknownFields: true });
        request.threadDefaults.workspaceId = user.threadDefaults?.workspaceId ?? "";
      } else if (key.section === "timezone") {
        if (!Predicate.isString(payload["timezone"])) return { outcome: "same" };
        request.timezone = payload["timezone"];
      } else request.textGeneration = fromJson(ui.TextGenerationSettingsSchema, payload, { ignoreUnknownFields: true });

      try {
        await sharedLocal(hostContext, "UpdateUserSettings", request);

        return { outcome: "applied", tokens: {} };
      } catch (error) {
        if (attempt >= 2 || !(error instanceof ConnectError && error.code === Code.FailedPrecondition)) throw error;
      }
    }
  } catch (error) {
    return failure(error);
  }
}

export async function sharedSecretValues(
  hostContext: SharedConfig,
  refs: Map<string, string>,
): Promise<link.SharedSecret[]> {
  if (!refs.size) return [];

  const rows = await hostContext.store.query<{ id: string; ciphertext: Uint8Array }>(
    "SELECT id::text,ciphertext FROM secrets WHERE id=ANY($1::uuid[])",
    [[...refs.values()]],
  );

  const byRef = new Map(rows.map((r) => [r.id, r.ciphertext]));

  return [...refs].flatMap(([token, ref]) =>
    byRef.has(ref)
      ? [create(link.SharedSecretSchema, { token, value: decryptSecret(hostContext.store.key, byRef.get(ref)!) })]
      : [],
  );
}

export interface SharedValuesMethods {
  read(key: SharedKey, tokens?: Record<string, string>): Promise<Value | undefined>;
}

export const sharedValuesMethods: SharedValuesMethods = {
  // ------------------------------------------------------------------ local values

  /** The shared fields of an item on this computer; undefined when it does not exist here. */
  async read(this: SharedConfig, key: SharedKey, tokens: Record<string, string> = {}): Promise<Value | undefined> {
    const value = (payload: Payload, next: Record<string, string> = {}, empty = false): Value => ({
      payload,
      tokens: next,
      refs: new Map(Object.entries(next).map(([ref, token]) => [token, ref])),
      empty,
    });

    if (key.kind === "instance" || key.kind === "models") {
      const row = (
        await this.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
          key.harness,
          key.id,
        ])
      )[0];

      if (!row) return undefined;

      if (key.kind === "models")
        return value(
          { favorites: row.favorites, hidden: row.hidden_models, shown: row.shown_models, custom: row.custom_models },
          {},
          ![row.favorites, row.hidden_models, row.shown_models, row.custom_models].some((l) => l.length),
        );

      // CLI paths, launch arguments, logins and the workers it runs on stay on each computer.
      if (row.built_in) return undefined;
      const next: Record<string, string> = {};
      const token = (ref: string) => (next[ref] = tokens[ref] ?? randomBytes(16).toString("hex"));

      return value(
        {
          label: row.label,
          kind: row.kind,
          baseUrl: row.base_url,
          accentColor: row.accent_color,
          apiKey: isRef(row.api_key) ? token(row.api_key.secretRef) : null,
          env: (row.env ?? []).map((v: StoredEnvVar) =>
            v.secret && isRef(v.value)
              ? { name: v.name, secret: true, token: token(v.value.secretRef) }
              : { name: v.name, value: String(v.value) },
          ),
        },
        next,
      );
    }

    if (key.kind === "project") {
      const row = (
        await this.store.query<{ name: string; kind: string; archived_at: Date | null }>(
          "SELECT name,kind,archived_at FROM projects WHERE id=$1::uuid AND owner_user_id=$2::uuid",
          [key.id, this.store.owner],
        )
      )[0];

      return row && row.kind === "project" && !row.archived_at ? value({ name: row.name }) : undefined;
    }

    if (key.kind !== "settings") return undefined;

    const stored =
      (
        await this.store.query<{ settings: Record<string, JsonValue> }>(
          "SELECT settings FROM user_settings WHERE user_id=$1::uuid",
          [this.store.owner],
        )
      )[0]?.settings ?? {};

    const read = <T>(json: JsonValue | undefined, parse: (j: JsonValue) => T) =>
      json === undefined ? undefined : parse(json);

    let payload: Payload;

    if (key.section === "appearance") {
      const a =
        read(stored["appearance"], (j) => fromJson(ui.AppearanceSettingsSchema, j, { ignoreUnknownFields: true })) ??
        create(ui.AppearanceSettingsSchema);

      // Panel and sidebar layout follow each screen; only the look is shared.
      payload = payloadObject(
        toJson(
          ui.AppearanceSettingsSchema,
          create(ui.AppearanceSettingsSchema, {
            colorScheme: a.colorScheme,
            accent: a.accent,
            lightTheme: a.lightTheme,
            darkTheme: a.darkTheme,
            chatWidth: a.chatWidth,
          }),
        ),
      );
    } else if (key.section === "thread_defaults") {
      const t =
        read(stored["threadDefaults"], (j) => fromJson(ui.ThreadDefaultsSchema, j, { ignoreUnknownFields: true })) ??
        create(ui.ThreadDefaultsSchema);

      // A workspace is a directory on one machine.
      t.workspaceId = "";
      payload = payloadObject(toJson(ui.ThreadDefaultsSchema, t));
    } else if (key.section === "timezone")
      payload = Predicate.isString(stored["timezone"]) && stored["timezone"] ? { timezone: stored["timezone"] } : {};
    else
      payload = payloadObject(
        toJson(
          ui.TextGenerationSettingsSchema,
          read(stored["textGeneration"], (j) =>
            fromJson(ui.TextGenerationSettingsSchema, j, { ignoreUnknownFields: true }),
          ) ?? create(ui.TextGenerationSettingsSchema),
        ),
      );

    return value(payload, {}, !Object.keys(payload).length);
  },
};

async function writeInstance(
  hostContext: SharedConfig,
  key: Extract<SharedKey, { kind: "instance" | "models" }>,
  payload: Payload,
  secrets: Map<string, string>,
  current: Value | undefined,
): Promise<Outcome & { tokens?: Record<string, string> }> {
  const row = (
    await hostContext.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
      key.harness,
      key.id,
    ])
  )[0];

  if (row?.built_in) return { outcome: "rejected", message: "the built-in login is configured on each computer" };
  const known = current?.payload ?? {};

  const knownEnv = new Map((Array.isArray(known["env"]) ? envValues(known["env"]) : []).map((v) => [v.name, v.token]));

  const missing: string[] = [];

  const secret = (token: string, same: boolean) => {
    if (same) return undefined;
    const value = secrets.get(token);

    if (value === undefined) missing.push(token);

    return value;
  };

  const apiKey =
    payload["apiKey"] === null
      ? row && isRef(row.api_key)
        ? ""
        : undefined
      : secret(String(payload["apiKey"]), known["apiKey"] === payload["apiKey"]);

  const env = envValues(payload["env"]).map((v) =>
    v.secret
      ? { name: v.name, secret: true, value: secret(v.token!, knownEnv.get(v.name) === v.token) }
      : { name: v.name, secret: false, value: v.value ?? "" },
  );

  if (missing.length) return { outcome: "secrets" };
  const runtime = row?.runtime ?? {};
  await sharedLocal(
    hostContext,
    "SaveProviderInstance",
    create(ui.SaveProviderInstanceRequestSchema, {
      harness: providerOf(key.harness),
      id: key.id,
      create: !row,
      label: String(payload["label"]),
      kind: payload["kind"] === "endpoint" ? ProviderProfileKind.CLIPROXYAPI : ProviderProfileKind.NATIVE,
      baseUrl: String(payload["baseUrl"] ?? ""),
      ...(apiKey !== undefined && { apiKey }),
      env,
      accentColor: String(payload["accentColor"] ?? ""),
      runtime: {
        binaryPath: runtime.binaryPath ?? "",
        homePath: runtime.homePath ?? "",
        shadowHomePath: runtime.shadowHomePath ?? "",
        launchArgs: runtime.launchArgs ?? [],
        ownLogin: runtime.ownLogin === true,
      },
      // A new shared instance is usable on this computer's workers at once; the choice stays local afterwards.
      allWorkers: true,
    }),
  );

  const saved = (
    await hostContext.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
      key.harness,
      key.id,
    ])
  )[0]!;

  const tokens: Record<string, string> = {};

  if (isRef(saved.api_key) && Predicate.isString(payload["apiKey"]))
    tokens[saved.api_key.secretRef] = payload["apiKey"];
  const incoming = new Map(envValues(payload["env"]).map((v) => [v.name, v.token]));

  for (const v of saved.env ?? [])
    if (v.secret && isRef(v.value) && incoming.get(v.name)) tokens[v.value.secretRef] = incoming.get(v.name)!;

  return { outcome: "applied", tokens };
}
