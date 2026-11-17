import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { coreProfileModels } from "./core-models.ts";
import { serviceTierProblem } from "../store/models.ts";
import { providerOf } from "../store/instance-config.ts";

/** A same-account side thread inherits execution speed; explicit Standard clears that inheritance. */
export async function inheritThreadServiceTier(core: GatewayCore, request: ui.CreateThreadRequest) {
  if (!request.parentThreadId || request.serviceTier) return request;
  const parent = await coreRun(core, (store) => store.thread(request.parentThreadId));

  if (parent.owner_user_id !== core[coreState].options.userId) throw new InvalidError("thread not found");

  if (
    providerOf(parent.provider) !== request.provider ||
    (parent.provider_profile_id || "native") !== (request.providerProfileId || "native")
  )
    return request;

  const serviceTier = parent.settings.serviceTier ?? "";

  if (serviceTier && serviceTier !== "default" && request.model !== (parent.settings.model ?? "")) {
    const { models } = await coreProfileModels(core, {
      workspaceId: request.workspaceId,
      provider: request.provider,
      profileId: request.providerProfileId,
    });

    if (serviceTierProblem(models, request.model, serviceTier)) return request;
  }

  return { ...request, serviceTier };
}
