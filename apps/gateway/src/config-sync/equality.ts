import { type JsonValue } from "@bufbuild/protobuf";
import { Effect, Predicate } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret } from "../store/secrets.ts";
import { equalValue, type Field } from "./persistence.ts";
import { secretField } from "./provider-values.ts";
import type { Cipher } from "./secrets.ts";

/** Compare effective values without changing their LWW versions or exposing secrets. */
export function configEquality(sql: SqlClient.SqlClient, owner: string, key: Buffer) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ kind: string; alias_id: string; global_id: string }>`SELECT kind,alias_id,global_id
      FROM config_aliases WHERE owner_user_id=${owner}::uuid`;

    const aliases = new Map(rows.map((r) => [`${r.kind}:${r.alias_id}`, r.global_id]));

    const canonical = (kind: string, id: string) => {
      const seen = new Set<string>();

      while (!seen.has(id) && aliases.has(`${kind}:${id}`)) {
        seen.add(id);
        id = aliases.get(`${kind}:${id}`)!;
      }

      return id;
    };

    const value = (kind: string, name: string, raw: JsonValue): JsonValue => {
      if (kind === "instance" && name === "proxy" && Predicate.isString(raw)) return canonical("proxy", raw);

      if (kind === "settings" && raw === null) {
        if (name === "general.confirmDelete") return true;

        if (name === "cliUpdates.intervalMinutes") return 360;
      }

      return raw;
    };

    return (kind: string, name: string, a: Field, b: Field, cipher?: Cipher) => {
      if (equalValue(value(kind, name, a.value), value(kind, name, b.value))) return true;

      if (!secretField(kind, name, a.value) || !secretField(kind, name, b.value)) return false;
      const left = cipher?.(name, a);
      const right = cipher?.(name, b);

      // Missing secret material cannot prove equality, even when the public placeholders look alike.
      return !!left && !!right && decryptSecret(key, left) === decryptSecret(key, right);
    };
  });
}
