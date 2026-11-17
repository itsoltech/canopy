import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreProfileModels } from "./core-models.ts";
import { inheritedServiceTier } from "../store/models.ts";
import type { ThreadRow } from "../store/rows.ts";

/** An omitted override follows the thread while allowing a model without accelerated execution. */
export async function messageServiceTier(core: GatewayCore, thread: ThreadRow, request: ui.SendMessageRequest) {
  if (request.serviceTier) return request.serviceTier;
  const { models } = await coreProfileModels(core, { thread });

  return inheritedServiceTier(
    models,
    request.model || thread.settings.model || "",
    thread.settings.model ?? "",
    thread.settings.serviceTier ?? "",
  );
}
