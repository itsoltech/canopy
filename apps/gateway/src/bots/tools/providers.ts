import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { NotFound } from "../../store/store.ts";
import { bool, define, json, object, provider, providerSchema, str, strings } from "./shared.ts";

const instanceView = (i: ui.ProviderInstance, workers: Set<string>) => ({ id: i.id, label: i.label, provider: Provider[i.harness], kind: i.kind, models: i.models && json(ui.InstanceModelsSchema, i.models), all_workers: i.allWorkers,
  // Whitelist intentionally omits every environment value, endpoint, runtime and credential.
  env: i.env.map((v) => ({ name: v.name, secret: v.secret })),
  workers: i.workers.filter((w) => workers.has(w.workerId)).map((w) => ({ worker_id: w.workerId, enabled: w.enabled, available: w.available, synced: w.synced })),
});
export const providerTools = [
  define("list_provider_instances", "Providers: list configured instances, model selections and availability on accessible workers. Environment variable names only; no values or credentials. Global instance definitions are shared by the installation, like the UI.", object({}), "Checking providers", async ({ core }) => {
    const workers = new Set((await core.overview()).workers.map((w) => w.id));
    return (await core.listProviderInstances()).map((i) => instanceView(i, workers));
  }, "read"),
  define("set_instance_worker", "Providers: enable or disable an existing instance on one worker. Requires approval. Does not change endpoint, environment, login or secret values.", object({ provider: providerSchema, provider_instance: str, worker_id: str, enabled: bool }, ["provider", "provider_instance", "worker_id", "enabled"]), "Updating provider availability", ({ core, string, args, action }) => action(async () => {
    const workers = new Set((await core.overview()).workers.map((w) => w.id));
    if (!workers.has(string("worker_id"))) throw new NotFound("worker not found");
    return instanceView(await core.setInstanceWorker(create(ui.SetInstanceWorkerRequestSchema, { harness: provider(args["provider"]), id: string("provider_instance"), workerId: string("worker_id"), enabled: args["enabled"] as boolean })), workers);
  }), "approval"),
  define("set_instance_models", "Providers: replace only the supplied favorites, hidden or shown model lists for an instance. Omitted lists and custom models are preserved. Requires approval; use list_models for ids.", object({ provider: providerSchema, provider_instance: str, favorites: strings, hidden: strings, shown: strings }, ["provider", "provider_instance"]), "Updating model selections", ({ core, string, args, action }) => action(async () => {
    const harness = provider(args["provider"]);
    const current = (await core.listProviderInstances()).find((i) => i.harness === harness && i.id === string("provider_instance"));
    if (!current) throw new NotFound("provider instance not found");
    const models = create(ui.InstanceModelsSchema, { favorites: args["favorites"] as string[] ?? current.models?.favorites ?? [], hidden: args["hidden"] as string[] ?? current.models?.hidden ?? [], shown: args["shown"] as string[] ?? current.models?.shown ?? [], custom: current.models?.custom ?? [] });
    const result = await core.setInstanceModels(create(ui.SetInstanceModelsRequestSchema, { harness, id: current.id, models }));
    return { id: result.id, models: result.models && json(ui.InstanceModelsSchema, result.models) };
  }), "approval"),
];
