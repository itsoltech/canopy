import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { InstanceApi } from "./instance-checks.ts";
import { instanceReads, instanceSync, instanceWrites } from "./instance-queries.ts";
import { instanceMutations, instanceSave } from "./instance-save.ts";
import { instanceModels } from "./instance-models.ts";
import { proxyStore } from "./proxies.ts";
import { proxyEnvMove } from "./proxy-env-move.ts";
import { queryMethods } from "../diagnostics/query-context.ts";

/**
 * Global provider instances (docs/worker-config.md, section 9). An instance (harness + id) is defined once here
 * (provider_instances) and enabled on the workers the user chooses (provider_instance_workers, with per-worker
 * overrides). What a worker runs stays its versioned configuration: after every change `sync` writes each
 * affected worker's effective instances (instance-config.ts) into worker_configs.config.profiles as a new version
 * (history kept); the core then pushes it to the workers online. Secrets (endpoint key, variables marked secret)
 * are encrypted into `secrets` and referenced as {"secretRef": "<secrets.id>"}; they never leave this store in
 * clear. Model choices (favorites, visibility, custom models) are the gateway's own and change no version.
 */

export { InstanceConflict, type SaveInstanceInput } from "./instance-checks.ts";

export class InstanceStore extends Context.Service<InstanceStore, InstanceApi>()("canopy/gateway/InstanceStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      InstanceStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reads = instanceReads(sql);
        const core = { ...reads, ...instanceWrites(sql, secretsKey, reads), ...instanceSync(sql, reads, secretsKey) };
        const saves = instanceSave(sql, core, secretsKey);
        const proxies = proxyStore(sql, secretsKey, core);

        return InstanceStore.of(
          queryMethods("settings.store", {
            list: core.list,
            get: core.get,
            ...saves,
            ...instanceMutations(sql, core, secretsKey),
            ...instanceModels(sql, core),
            ...proxies,
            moveInstanceToProxy: proxyEnvMove(sql, secretsKey, core, { ...saves, ...proxies }),
          }),
        );
      }),
    );
}
