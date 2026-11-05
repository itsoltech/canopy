import { ui } from "@canopy/contracts";
import { isEntityId } from "@canopy/domain/computers";
import { isCheckInterval } from "@canopy/domain/update-checks";
import { harnessOf } from "../store/index.ts";
import { checkFavorites, InvalidError } from "./core-context.ts";
import { checkWorkerGatewayUrl } from "./worker-administration.ts";

/** Shared by local UI writes and config materialization before the domain store is changed. */
export function validateUserSettings(request: ui.UpdateUserSettingsRequest) {
  const interval = request.cliUpdates?.intervalMinutes;

  if (interval !== undefined && !isCheckInterval(interval)) throw new InvalidError("invalid CLI update check interval");

  if (request.workerGatewayUrl !== undefined) checkWorkerGatewayUrl(request.workerGatewayUrl);

  if (request.attachmentLimits) {
    const { maxFileBytes, maxMessageBytes, maxFiles } = request.attachmentLimits;

    if (
      maxFileBytes < 1n ||
      maxFileBytes > 30n * 1024n ** 2n ||
      maxMessageBytes < maxFileBytes ||
      maxMessageBytes > 1024n ** 3n ||
      maxFiles < 1 ||
      maxFiles > 100
    )
      throw new InvalidError(
        "Choose up to 30 MiB per file, at least that much per message (up to 1 GiB), and 1–100 files.",
      );
  }

  if (request.timezone !== undefined) {
    try {
      if (!request.timezone || request.timezone.length > 100 || /^[+-]/.test(request.timezone)) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: request.timezone }).format();
    } catch {
      throw new InvalidError("unknown IANA timezone");
    }
  }

  if (request.sidebar) {
    if (!(request.sidebar.projectOrder in ui.ProjectOrder)) throw new InvalidError("unknown project order");
    const ids = [...request.sidebar.projectIds, ...request.sidebar.pinnedThreadIds, ...request.sidebar.pinnedBotIds];

    if (ids.length > 1000 || ids.some((id) => !isEntityId(id))) throw new InvalidError("invalid sidebar ids");
  }

  if (request.modelFavorites) checkFavorites(request.modelFavorites);

  if (request.composer && !(request.composer.runningDelivery in ui.MessageDelivery))
    throw new InvalidError("unknown message delivery");

  if (request.textGeneration) {
    const t = request.textGeneration;

    if (
      t.threadTitleInstructions.length > 4_000 ||
      t.profileId.length > 100 ||
      t.model.length > 200 ||
      t.effort.length > 40
    )
      throw new InvalidError("text generation setting is too long");

    if (t.model && !harnessOf(t.provider)) throw new InvalidError("text generation needs a provider instance");

    if (t.effort && !/^[a-z][a-z0-9_-]*$/.test(t.effort)) throw new InvalidError("invalid text generation effort");
  }
}
