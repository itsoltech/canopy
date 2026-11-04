import { ui, type ModelInfo } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { harnessKey, instanceKeyOf, listInstances, providerCall } from "./instances.ts";

/**
 * The Providers page's data: every global instance with its state per worker, and the workers' full model catalogs
 * (without the instances' choices, so hidden models can be shown again). Seeded by the page load, then kept current
 * by its own calls: after every change, and when a worker reports again (the page watches the overview).
 */
export class ProvidersState {
  instances = $state.raw<ui.ProviderInstance[]>([]);
  catalogs = $state.raw<readonly ui.WorkerModels[]>([]);
  /** When the workers were last asked to check again (Refresh). */
  checkedAt = $state.raw<Date | undefined>();
  refreshing = $state(false);
  /** Why the last refresh skipped workers. */
  skipped = $state.raw<readonly string[]>([]);

  constructor(initial: { instances: ui.ProviderInstance[]; catalogs: readonly ui.WorkerModels[] }) {
    this.instances = initial.instances;
    this.catalogs = initial.catalogs;
  }

  find(key: string | undefined): ui.ProviderInstance | undefined {
    return key ? this.instances.find((i) => instanceKeyOf(i) === key) : undefined;
  }

  /** An instance as a call returned it. */
  put(instance: ui.ProviderInstance | undefined): void {
    if (!instance) return;
    const key = instanceKeyOf(instance);
    const exists = this.instances.some((i) => instanceKeyOf(i) === key);
    this.instances = exists
      ? this.instances.map((i) => (instanceKeyOf(i) === key ? instance : i))
      : [...this.instances, instance];
  }

  async reload(): Promise<void> {
    this.instances = await listInstances();
  }

  async reloadModels(): Promise<void> {
    this.catalogs = decode(ui.ListModelsResponseSchema, await requestJson("GET", "/api/models?unfiltered=1")).workers;
  }

  /** Versions, availability and logins checked again on the online workers. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      const response = await providerCall("refresh", {}, 75_000);
      this.instances = response.instances;
      this.skipped = response.skipped;
      this.checkedAt = new Date();
      await this.reloadModels().catch(() => {});
    } finally {
      this.refreshing = false;
    }
  }

  /** The catalog models of an instance: on one worker, or merged over all its workers. */
  models(instance: ui.ProviderInstance, workerId: string | undefined): ModelInfo[] {
    const lists = this.catalogs
      .filter((c) => !workerId || c.workerId === workerId)
      .flatMap((c) =>
        c.profiles.filter(
          (p) => harnessKey(p.provider) === harnessKey(instance.harness) && (p.profileId || "native") === instance.id,
        ),
      );

    const seen = new Set<string>();

    return lists.flatMap((l) => l.models).filter((m) => !seen.has(m.id) && seen.add(m.id));
  }
}
