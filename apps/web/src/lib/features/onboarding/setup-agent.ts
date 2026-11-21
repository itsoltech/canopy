import { CliInstallMethod, Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { accountAction } from "@canopy/domain/provider-accounts";
import { modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
import { instanceOf, providerKeys, type ProviderKey } from "#lib/features/threads/providers.ts";

function loginProblem(instance: ui.WorkerInstance | undefined): "signed_out" | "expired" | undefined {
  if (instance?.kind !== ProviderProfileKind.NATIVE) return undefined;
  const account = instance.account ?? instance.status?.account;

  if (account?.state === "signed_out") return "signed_out";

  if (accountAction(account) === "sign_in_again") return "expired";

  return undefined;
}

/** The new-thread picker’s confirmed model choices for the worker's current configuration. */
export function setupAgentModels(worker: ui.Worker | undefined, catalog: ui.WorkerModels | undefined): ModelOption[] {
  if (!worker?.online || worker.revokedAt || catalog?.workerId !== worker.id) return [];

  if (worker.configVersion !== worker.appliedVersion || catalog.configVersion !== worker.configVersion) return [];

  return modelOptions({ worker, catalog, threads: [] }).filter(
    (model) => model.origin === "catalog" && !loginProblem(instanceOf(worker, model.provider, model.profileId)),
  );
}

export function setupAgentReady(worker: ui.Worker | undefined, catalog: ui.WorkerModels | undefined): boolean {
  return setupAgentModels(worker, catalog).length > 0;
}

type SetupAgentStatus =
  | "ready"
  | "installing"
  | "missing_cli"
  | "unknown_cli"
  | "cli_error"
  | "syncing"
  | "checking_models"
  | "turned_off"
  | "signed_out"
  | "expired"
  | "unavailable";

interface SetupAgentRow {
  provider: ProviderKey;
  status: SetupAgentStatus;
  instance?: ui.WorkerInstance | undefined;
}

function setupAgentRow(
  worker: ui.Worker,
  models: readonly ModelOption[],
  catalog: ui.WorkerModels | undefined,
  provider: ProviderKey,
): SetupAgentRow {
  const harness = Provider[provider];
  const model = models.find((option) => option.provider === provider);

  if (model) return { provider, status: "ready", instance: instanceOf(worker, provider, model.profileId) };
  const instances = worker.providerInstances.filter((instance) => instance.harness === harness);
  const tool = worker.cliTools.find((item) => item.tool?.provider === harness)?.tool;
  const report = worker.providers.find((entry) => entry.provider === harness);
  const runnable = report?.version || report?.available || instances.some((i) => i.available || i.status?.version);

  if (tool?.install?.state === "running") return { provider, status: "installing" };

  if (!runnable && tool?.versionError) return { provider, status: "cli_error" };

  if (!runnable && !tool?.path) {
    return { provider, status: tool?.method === CliInstallMethod.NOT_INSTALLED ? "missing_cli" : "unknown_cli" };
  }

  const native = instances.filter((instance) => instance.kind === ProviderProfileKind.NATIVE);

  const login =
    native.find((instance) => instance.enabled && instance.available) ??
    native.find((instance) => instance.enabled) ??
    native.find((instance) => instance.id === "native") ??
    native[0];

  const proxies = instances.filter((instance) => instance.enabled && instance.kind === ProviderProfileKind.CLIPROXYAPI);
  const proxy = proxies.find((instance) => instance.available) ?? proxies[0];

  if (worker.configVersion !== worker.appliedVersion && (proxy || login?.enabled)) {
    return { provider, status: "syncing", instance: proxy ?? login };
  }

  const loginIssue = loginProblem(login);
  const available = proxy?.available ? proxy : login?.available && !loginIssue ? login : undefined;

  if (available && catalog?.configVersion !== worker.configVersion) {
    return { provider, status: "checking_models", instance: available };
  }

  if (proxy?.available) return { provider, status: "unavailable", instance: proxy };

  if (login && !login.enabled) return { provider, status: "turned_off", instance: login };

  return { provider, status: loginIssue ?? "unavailable", instance: login ?? proxy };
}

export function setupAgentRows(worker: ui.Worker, catalog: ui.WorkerModels | undefined): SetupAgentRow[] {
  const models = setupAgentModels(worker, catalog);

  return providerKeys.map((provider) => setupAgentRow(worker, models, catalog, provider));
}
