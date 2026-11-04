import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { storedSidebarWidth } from "@canopy/domain";
import { harnessOf, SettingsStore } from "../store/index.ts";
import { checkWorkerGatewayUrl } from "./worker-administration.ts";
import { isEntityId } from "@canopy/domain/computers";
import { checkFavorites, coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";

/** Defaults must point at the user's own workspace (in the project, for project settings). */
export async function coreCheckThreadDefaults(
  hostContext: GatewayCore,
  defaults: ui.ThreadDefaults,
  projectId?: string,
): Promise<void> {
  if (defaults.providerProfileId.length > 100 || defaults.models.some((m) => m.model.length > 200))
    throw new InvalidError("model or profile id is too long");

  if (new Set(defaults.models.map((m) => m.provider)).size !== defaults.models.length)
    throw new InvalidError("one model per provider");

  if (!defaults.workspaceId) return;
  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === defaults.workspaceId);

  if (!workspace || (projectId && workspace.projectId !== projectId)) throw new InvalidError("workspace not found");
}

export function coreSettings<A, E>(
  hostContext: GatewayCore,
  use: (store: SettingsStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(SettingsStore.use(use));
}

export interface CoreSettingsMethods {
  settings(): Promise<ui.GetSettingsResponse>;
  updateUserSettings(request: ui.UpdateUserSettingsRequest): Promise<ui.UserSettings>;
  updateProjectSettings(request: ui.UpdateProjectSettingsRequest): Promise<ui.ProjectSettings>;
}

export const coreSettingsMethods: CoreSettingsMethods = {
  // ------------------------------------------------------------------ settings (UI)

  async settings(this: GatewayCore): Promise<ui.GetSettingsResponse> {
    const [user, projects] = await Promise.all([
      coreSettings(this, (s) => s.user(this[coreState].options.userId)),
      coreSettings(this, (s) => s.projects(this[coreState].options.userId)),
    ]);

    const limits = await this.attachmentLimits;

    return create(ui.GetSettingsResponseSchema, {
      user,
      projects,
      attachmentLimits: {
        maxFileBytes: BigInt(limits.maxFileBytes),
        maxMessageBytes: BigInt(limits.maxMessageBytes),
        maxFiles: limits.maxFiles,
      },
    });
  },

  /** The sidebar width is held within its limits instead of refused (a drag past them is not an error). */
  async updateUserSettings(this: GatewayCore, request: ui.UpdateUserSettingsRequest): Promise<ui.UserSettings> {
    if (request.workerGatewayUrl !== undefined) checkWorkerGatewayUrl(request.workerGatewayUrl);

    if (request.attachmentLimits) {
      const { maxFileBytes, maxMessageBytes, maxFiles } = request.attachmentLimits;

      // Keep all uploads within the transport's 32 MiB request budget, including protobuf overhead.
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
      const ids = [...request.sidebar.projectIds, ...request.sidebar.pinnedThreadIds, ...request.sidebar.pinnedBotIds];

      if (ids.length > 1000 || ids.some((id) => !isEntityId(id))) throw new InvalidError("invalid sidebar ids");
    }

    if (request.threadDefaults) await coreCheckThreadDefaults(this, request.threadDefaults);

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

    const settings = await coreSettings(this, (s) =>
      s.updateUser({
        userId: this[coreState].options.userId,
        ...(request.attachmentLimits && { attachmentLimits: request.attachmentLimits }),
        ...(request.workerGatewayUrl !== undefined && { workerGatewayUrl: request.workerGatewayUrl }),
        ...(request.appearance && {
          appearance: { ...request.appearance, sidebarWidth: storedSidebarWidth(request.appearance.sidebarWidth) },
        }),
        ...(request.timezone !== undefined && { timezone: request.timezone }),
        ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
        ...(request.modelFavorites && { modelFavorites: request.modelFavorites }),
        ...(request.composer && { composer: request.composer }),
        ...(request.textGeneration && { textGeneration: request.textGeneration }),
        ...(request.sidebar && {
          sidebar: {
            ...request.sidebar,
            projectIds: [...new Set(request.sidebar.projectIds)],
            pinnedThreadIds: [...new Set(request.sidebar.pinnedThreadIds)],
            pinnedBotIds: [...new Set(request.sidebar.pinnedBotIds)],
          },
        }),
        expectedVersion: request.expectedVersion,
      }),
    );

    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "userSettings", value: settings } }));

    return settings;
  },

  async updateProjectSettings(
    this: GatewayCore,
    request: ui.UpdateProjectSettingsRequest,
  ): Promise<ui.ProjectSettings> {
    if (request.threadDefaults) await coreCheckThreadDefaults(this, request.threadDefaults, request.projectId);

    const settings = await coreSettings(this, (s) =>
      s.updateProject({
        userId: this[coreState].options.userId,
        projectId: request.projectId,
        ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
        expectedVersion: request.expectedVersion,
      }),
    );

    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "projectSettings", value: settings } }));

    return settings;
  },
};
