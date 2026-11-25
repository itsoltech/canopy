import { sessionSelect } from "@canopy/acp";
import type { AcpThreadOptions } from "../acp/thread-types.ts";
import { AcpThreads } from "../acp/threads.ts";
import { antigravityLaunch, supportsAntigravityVersion } from "./launch.ts";
import { listAntigravityModels } from "./catalog.ts";
import { antigravityPermission } from "./permissions.ts";
import { AntigravityEventMapper, antigravityPlatformUse } from "./mapping.ts";
import { checkAntigravityMode, configureAntigravitySession } from "./session.ts";
import type { AntigravityPricing } from "./pricing.ts";

interface Options extends AcpThreadOptions {
  deviceHome?: string | undefined;
  pricing?: AntigravityPricing | undefined;
}

export class AntigravityThreads extends AcpThreads<Options> {
  constructor(options: Options) {
    super(options, {
      name: "Antigravity",
      kind: "antigravity",
      platformUse: antigravityPlatformUse,
      launch(spec, profile, settings) {
        checkAntigravityMode(settings.permissionMode);

        const launch = antigravityLaunch({
          ...options,
          profile,
          cwd: spec.cwd,
          scratch: spec.scratch,
          threadId: spec.threadId,
          permissionMode: settings.permissionMode,
        });

        let model = settings.model;

        return {
          ...launch,
          permission: (entry, request, signal) =>
            antigravityPermission(spec, entry, request, signal, options.interact, launch.allowSkillRead),
          validate(info) {
            if (!supportsAntigravityVersion(info.agentInfo?.version))
              throw new Error("Antigravity threads require agy 1.5.16 or a later 1.x version.");
          },
          async configure(client, session) {
            await configureAntigravitySession(client, session, settings);
            model = sessionSelect(session, "model")?.currentValue || session.models?.currentModelId || model;
          },
          mapper: (turnId) => new AntigravityEventMapper(turnId, spec.cwd, model, options.pricing),
        };
      },
    });
  }
  async listModels(profileId: string) {
    const profile = this.options.profile(profileId);

    if (!profile) throw new Error("Antigravity instance unavailable");

    return listAntigravityModels({ ...this.options, profile });
  }
}
