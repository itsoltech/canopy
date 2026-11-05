import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { storedSidebarWidth } from "@canopy/domain";
import { SettingsStore } from "../store/index.ts";
import { coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { validateUserSettings } from "./settings-validation.ts";
import { coreConfigsChanged } from "./core-providers.ts";
import { SqlClient } from "effect/sql";

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

/** Refresh only local workers that inherit the account's CLI update interval. */
export async function coreCliDefaultsChanged(host: GatewayCore) {
  const userId = host[coreState].options.userId;

  const changed = await host[coreState].options.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ worker_id: string }>`UPDATE worker_configs c SET version = c.version + 1,
        updated_by = ${userId}::uuid, updated_at = now() FROM workers w
        WHERE w.id = c.worker_id AND w.owner_user_id = ${userId}::uuid
          AND NOT (c.config ? 'cliUpdateCheckMinutes') RETURNING c.worker_id`;
    }),
  );

  await coreConfigsChanged(
    host,
    changed.map((row) => row.worker_id),
  );
  void host.cli.checks.tick().catch(() => undefined);
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
    validateUserSettings(request);

    if (request.threadDefaults) await coreCheckThreadDefaults(this, request.threadDefaults);

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
        ...(request.general && { general: request.general }),
        ...(request.cliUpdates && { cliUpdates: request.cliUpdates }),
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

    if (request.cliUpdates) await coreCliDefaultsChanged(this);

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
