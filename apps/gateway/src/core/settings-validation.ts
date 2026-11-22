import { ui, type SandboxProfile } from "@canopy/contracts";
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_FILE_MIB, validModuleOrder } from "@canopy/domain";
import { isEntityId } from "@canopy/domain/computers";
import { normalizeSandboxProfile } from "@canopy/domain/sandbox-profiles";
import { isCheckInterval } from "@canopy/domain/update-checks";
import { harnessOf } from "../store/index.ts";
import { checkFavorites, InvalidError } from "./core-context.ts";
import { validateAgentToolDefaults } from "./agent-tool-defaults-validation.ts";
import { checkWorkerGatewayUrl } from "./worker-administration.ts";

export function validateSandboxProfiles(section: ui.SandboxProfiles): ui.SandboxProfiles {
  let profiles: SandboxProfile[];

  try {
    profiles = section.profiles.map(normalizeSandboxProfile);
  } catch (error) {
    if (error instanceof Error) throw new InvalidError(error.message);
    throw error;
  }

  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new InvalidError("Each sandbox profile must have a unique ID.");

  if (new Set(profiles.map((profile) => profile.name.toLowerCase())).size !== profiles.length)
    throw new InvalidError("Choose a different name for each sandbox profile.");

  return { ...section, profiles };
}

/** Shared by local UI writes and config materialization before the domain store is changed. */
export function validateUserSettings(request: ui.UpdateUserSettingsRequest) {
  if (request.modules && !validModuleOrder(request.modules.enabled))
    throw new InvalidError("Choose Threads, Bots, or both. Each module can appear only once.");

  if (request.agentToolDefaults) validateAgentToolDefaults(request.agentToolDefaults);
  const interval = request.cliUpdates?.intervalMinutes;

  if (interval !== undefined && !isCheckInterval(interval)) throw new InvalidError("invalid CLI update check interval");

  const days = request.threadRetention?.archivedThreadDays;

  if (days !== undefined && (!Number.isInteger(days) || days < 0 || days > 36500))
    throw new InvalidError("Invalid archive retention. Choose 1–36500 days, or turn off auto-delete.");

  if (request.workerGatewayUrl !== undefined) checkWorkerGatewayUrl(request.workerGatewayUrl);

  if (request.attachmentLimits) {
    const { maxFileBytes, maxMessageBytes, maxFiles } = request.attachmentLimits;

    if (
      maxFileBytes < 1n ||
      maxFileBytes > BigInt(MAX_ATTACHMENT_FILE_BYTES) ||
      maxMessageBytes < maxFileBytes ||
      maxMessageBytes > 1024n ** 3n ||
      maxFiles < 1 ||
      maxFiles > 100
    )
      throw new InvalidError(
        `Choose up to ${MAX_ATTACHMENT_FILE_MIB} MiB per file, at least that much per message (up to 1 GiB), and 1–100 files.`,
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
