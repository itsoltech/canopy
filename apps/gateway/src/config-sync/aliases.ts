import { ScalarType, type DescMessage, type Message } from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { Effect, Predicate } from "effect";
import { type SqlClient, type SqlError } from "effect/sql";
import { harnessOf } from "../store/instance-config.ts";
import { mapIds } from "../computers/remote-ids.ts";

/**
 * Instance ids in calls between linked computers (docs/linked-computers.md, "Rekord, klucze i id"). Each computer
 * keeps its own instance ids; on the link they are global. Without an alias or another local id the two are
 * the same, so the translation is the identity.
 */

export type InstanceIds = {
  toGlobal(harness: string, id: string): string;
  toLocal(harness: string, id: string): string;
};

const PROFILE_FIELDS = new Set(["provider_profile_id", "profile_id", "provider_instance"]);

/** Worker settings that name an instance by `harness` and `id` (stage 6 edits at a worker's home). */
const INSTANCE_REQUESTS = new Set([
  "canopy.ui.v1.SetInstanceWorkerRequest",
  "canopy.ui.v1.SetInstanceWorkersRequest",
  "canopy.ui.v1.StartProviderLoginRequest",
  "canopy.ui.v1.RefreshProvidersRequest",
]);

export function instanceIds(sql: SqlClient.SqlClient, owner: string): Effect.Effect<InstanceIds, SqlError.SqlError> {
  return Effect.gen(function* () {
    const records = yield* sql<{ global_id: string; local_id: string }>`SELECT global_id,local_id FROM config_items
      WHERE owner_user_id=${owner}::uuid AND kind='instance' AND unsupported=''`;

    const aliases = yield* sql<{ alias_id: string; global_id: string }>`SELECT alias_id,global_id FROM config_aliases
      WHERE owner_user_id=${owner}::uuid AND kind='instance'`;

    const local = new Map(records.map((r) => [r.global_id, r.local_id]));
    const global = new Map(records.map((r) => [`${r.global_id.split(":")[0]}:${r.local_id}`, r.global_id]));
    const alias = new Map(aliases.map((a) => [a.alias_id, a.global_id]));
    const slug = (id: string) => id.slice(id.indexOf(":") + 1);

    return {
      toGlobal: (harness, id) => slug(global.get(`${harness}:${id}`) ?? `${harness}:${id}`),
      toLocal: (harness, id) => {
        const key = `${harness}:${id}`;

        return local.get(alias.get(key) ?? key) ?? id;
      },
    };
  });
}

/** The harness a message's instance id belongs to, from its sibling `provider` field (enum or name). */
function harnessIn(desc: DescMessage, message: Message): string | undefined {
  const field = desc.fields.find((f) => f.name === (INSTANCE_REQUESTS.has(desc.typeName) ? "harness" : "provider"));

  if (!field) return undefined;
  const value = reflect(desc, message).get(field);

  if (Predicate.isNumber(value)) return harnessOf(value);

  return Predicate.isString(value) ? value : undefined;
}

/** Rewrites instance ids in place; returns whether the message had any. */
export function mapInstanceIds(desc: DescMessage, message: Message, map: (harness: string, id: string) => string) {
  let found = false;
  mapIds(
    desc,
    message,
    (id) => id,
    (d, m) => {
      const harness = harnessIn(d, m);

      if (!harness) return;

      for (const field of d.fields) {
        const named = PROFILE_FIELDS.has(field.name) || (field.name === "id" && INSTANCE_REQUESTS.has(d.typeName));

        if (!named || field.fieldKind !== "scalar" || field.scalar !== ScalarType.STRING) continue;
        const record = reflect(d, m);
        const value = record.get(field);

        if (!Predicate.isString(value) || !value) continue;
        found = true;
        record.set(field, map(harness, value));
      }
    },
  );

  return found;
}
