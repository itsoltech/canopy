import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { ProviderProfileKind, ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import type { InstanceApi } from "./instance-checks.ts";
import { harnessOrFail, InstanceConflict, envSettings } from "./instance-checks.ts";
import { isRef } from "./instance-config.ts";
import type { InstanceCore } from "./instance-queries.ts";
import { Invalid } from "./store.ts";
import { proxyRecords } from "./proxy-records.ts";
import type { ProxyApi } from "./proxies.ts";

export function proxyEnvMove(
  sql: SqlClient.SqlClient,
  key: Buffer,
  core: InstanceCore,
  api: Pick<InstanceApi, "save"> & ProxyApi,
) {
  const records = proxyRecords(sql, key);

  return (userId: string, request: ui.MoveInstanceToProxyRequest) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const harness = yield* harnessOrFail(request.harness);
        const row = yield* core.lockInstance(harness, request.id);

        if (row.proxy_id) yield* records.get(userId, row.proxy_id);

        if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(row.revision))
          return yield* Effect.fail(new InstanceConflict("The instance changed meanwhile; reload and try again"));
        const source = row.env;
        const urlNames = harness === "claude" ? ["ANTHROPIC_BASE_URL"] : ["OPENAI_BASE_URL", "CODEX_BASE_URL"];

        const keyNames =
          harness === "claude" ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] : ["CLIPROXY_API_KEY", "OPENAI_API_KEY"];

        const url = source.find((v) => urlNames.includes(v.name.toUpperCase()));

        const token = keyNames
          .flatMap((name) => source.filter((v) => v.name.toUpperCase() === name && (isRef(v.value) || v.value)))
          .at(0);

        if (!url || !token)
          return yield* Effect.fail(
            new Invalid("No complete endpoint URL and key were found in this instance's environment"),
          );

        const read = (value: typeof url.value) =>
          isRef(value) ? records.secret(userId, value.secretRef) : Effect.succeed(value);

        const baseUrl = yield* read(url.value);
        const secret = yield* read(token.value);
        const moved = new Set([...urlNames, ...keyNames]);
        const env = source.filter((v) => !moved.has(v.name.toUpperCase()));

        const input = envSettings(env).map((v) =>
          create(ui.ProfileEnvVarInputSchema, { name: v.name, secret: v.secret, ...(!v.secret && { value: v.value }) }),
        );

        const { proxy } = yield* api.saveProxy(
          userId,
          create(ui.SaveProxyRequestSchema, {
            name: request.name || row.label || "Migrated proxy",
            kind: "cliproxyapi",
            baseUrl,
            secret,
          }),
        );

        const id = row.built_in ? request.newInstanceId : row.id;

        if (!id) return yield* Effect.fail(new Invalid("Give the new proxy instance an ID"));

        if (row.built_in) {
          yield* sql`UPDATE provider_instances SET env = ${JSON.stringify(env)}::jsonb, revision = revision + 1, updated_at = now()
        WHERE harness = ${harness} AND id = ${row.id}`;
        } else if (
          (yield* core.threadUse()).some((u) => u.harness === harness && u.id === row.id && Number(u.count) > 0)
        ) {
          return yield* Effect.fail(
            new InstanceConflict(
              "Threads use this device-login instance; add a separate instance before moving its connection",
            ),
          );
        }

        const saved = yield* api.save({
          userId,
          request: create(ui.SaveProviderInstanceRequestSchema, {
            harness: request.harness,
            id,
            create: row.built_in,
            label: request.name || `${row.label || harness} proxy`,
            kind: ProviderProfileKind.CLIPROXYAPI,
            proxyId: proxy.id,
            env: row.built_in ? [] : input,
            runtime: { ...row.runtime, ownLogin: false },
            accentColor: row.accent_color,
            allWorkers: row.all_workers,
            workerIds: (yield* core.assignments())
              .filter((a) => a.harness === harness && a.instance_id === row.id && a.enabled)
              .map((a) => a.worker_id),
          }),
        });

        yield* records.audit(userId, proxy.id, "proxy.environment_moved");

        return saved;
      }),
    );
}
