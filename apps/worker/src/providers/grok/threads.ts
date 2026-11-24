import { AcpClient } from "@canopy/acp";
import { PermissionMode } from "@canopy/contracts";
import { AcpThreads } from "../acp/threads.ts";
import type { AcpThreadOptions } from "../acp/thread-types.ts";
import { closeAcpResources } from "../acp/cleanup.ts";
import { proxyModelFits, proxyModels, type ModelInit } from "../models.ts";
import { concreteModelName } from "../model-metadata.ts";
import type { XaiPricingCatalog } from "../pricing/model-catalog.ts";
import { GrokSessionCost } from "./consumed-usage.ts";
import { grokLaunch } from "./launch.ts";
import { grokPermission } from "./lifecycle.ts";
import { GrokEventMapper, grokPlatformUse } from "./mapping.ts";
import { discoveredModels } from "./model-discovery.ts";
import { grokSecretHooks } from "./secret-hooks.ts";

interface Options extends AcpThreadOptions {
  pricing?: XaiPricingCatalog;
}

export class GrokThreads extends AcpThreads<Options> {
  constructor(options: Options) {
    super(options, {
      name: "Grok",
      kind: "grok",
      platformUse: grokPlatformUse,
      launch(spec, profile, chosen, resuming) {
        const readOnly = chosen.permissionMode === PermissionMode.READ_ONLY;

        const launch = grokLaunch({
          dataDir: options.dataDir,
          // Scratch must never trust an enclosing repository.
          profile: spec.scratch ? { ...profile, env: { ...profile.env, GROK_FOLDER_TRUST: "1" } } : profile,
          executable: options.executable,
          model: chosen.model,
          effort: chosen.effort,
          readOnly,
          fullAuto: chosen.permissionMode === PermissionMode.FULL_AUTO,
          fullAccess: chosen.permissionMode === PermissionMode.FULL_ACCESS,
          linkDeviceLogin: options.linkDeviceLogin,
        });

        const costs = new GrokSessionCost(resuming);
        let hooks: ReturnType<typeof grokSecretHooks> | undefined;

        try {
          // Linux read-only Grok profiles refuse private HTTP hooks before making the request.
          if (process.platform !== "linux" || !readOnly) hooks = grokSecretHooks(spec.threadId, launch.home);
        } catch (error) {
          launch.cleanup();
          throw error;
        }

        return {
          options: launch.options,
          permission: (entry, request, signal) => grokPermission(spec, entry, request, signal, options.interact),
          cleanup: () => closeAcpResources([() => hooks?.close(), launch.cleanup]),
          async configure(client, session) {
            if (hooks && client.capabilities) {
              hooks.bind(session.sessionId, client.capabilities);
              // A stopped harness can no longer protect newly delivered project secrets.
              void client.exited.then(() => hooks?.close()).catch(() => {});
            }

            if (chosen.model && session.models && session.models.currentModelId !== chosen.model)
              await client.setModel(session.sessionId, chosen.model);
          },
          mapper: (turnId) => new GrokEventMapper(turnId, spec.cwd, costs, options.pricing),
        };
      },
    });
  }
  async listModels(profileId: string): Promise<{ models: ModelInit[] }> {
    const profile = this.options.profile(profileId);

    if (!profile) throw new Error("Grok instance unavailable");

    const launch = grokLaunch({
      dataDir: this.options.dataDir,
      profile,
      executable: this.options.executable,
      linkDeviceLogin: this.options.linkDeviceLogin,
    });

    const client = new AcpClient(launch.options);

    try {
      const info = await client.initialize();
      const known = discoveredModels(info, profile.runtime.grokSettings?.models?.default_reasoning_effort);

      if (profile.kind !== "cliproxyapi") return { models: known };
      const models = (await proxyModels(profile)).filter((m) => proxyModelFits("grok", m));

      return {
        models: models.map(
          (m) =>
            known.find((k) => k.id === m.id) ?? {
              id: m.id,
              displayName: m.displayName || concreteModelName(m.id),
              efforts: [],
              isDefault: false,
            },
        ),
      };
    } finally {
      await closeAcpResources([() => client.dispose(), launch.cleanup]);
    }
  }
}
