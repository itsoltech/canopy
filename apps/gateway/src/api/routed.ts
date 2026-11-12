import { clone, create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots, computerLink as link, ui } from "@canopy/contracts";
import { nodeRef, splitId, REMOTE_WORKTREES } from "@canopy/domain/computers";
import { Code, ConnectError, createHandlerContext } from "@connectrpc/connect";
import { linkedMessage, mapIds, methodNamed, SERVED, WORKER_SETTINGS, type RemoteServe } from "../computers/remote.ts";
import type { SharedHost } from "../config-sync/host.ts";
import type { GatewayCore } from "../core/core.ts";
import {
  redirected,
  refuseFrozen,
  refuseForeignAdministration,
  single,
  stream,
  target,
  unary,
  unaryTimeout,
  type Handler,
} from "./routed-context.ts";
import { forward, peerOf } from "./routed-home.ts";
import { absorb, gather, watchOverview } from "./routed-overview.ts";
import { toConnectError } from "./ui-errors.ts";
import { ConfigIds, localProjectIds, refuseMissingInstance } from "./routed-config.ts";
import { harnessOf } from "../store/instance-config.ts";
import type { UiHandlers } from "./ui-service.ts";
import { refuseRemoteWorktree, refuseRemoteBranchSwitch } from "../worktrees/remote.ts";
import { validateUserSettings } from "../core/settings-validation.ts";
import { coreCheckThreadDefaults, coreCliDefaultsChanged } from "../core/core-settings.ts";
import { coreConfigsChanged } from "../core/core-providers.ts";
import { coreModelCatalogs, corePublishModels } from "../core/core-models.ts";
import { receivedWorkerSetting, receiveWorkerSetting, sendWorkerSetting, settled } from "./routed-workers.ts";
import { splitOverrides } from "./routed-workers-split.ts";
import { auditHomeAction, receiveHomeAction } from "./routed-execution.ts";
import { executionLists } from "./routed-execution-lists.ts";
import { linkedManageUpdates } from "./routed-updates.ts";
import { linkedWrite } from "../computers/write-diagnostics.ts";
import { bindGitHubRequest } from "./github-client.ts";

export function routed(core: GatewayCore, local: UiHandlers): UiHandlers {
  // SAFETY: Each entry is invoked with the request decoded by its own GatewayService method descriptor.
  const own = local as Record<string, Handler>;
  const handlers: Record<string, Handler> = {};

  for (const method of ui.GatewayService.methods) {
    const handler = own[method.localName]!;

    if (!SERVED.has(method.name)) {
      // Settings, credentials and administration stay per computer in this stage.
      handlers[method.localName] =
        method.methodKind === "unary"
          ? async (request, context) => {
              refuseForeignAdministration(method, request);
              const response = await unary(handler, request, context);

              return response;
            }
          : async function* (request, context) {
              refuseForeignAdministration(method, request);
              yield* stream(handler, request, context);
            };

      continue;
    }

    handlers[method.localName] =
      method.methodKind === "unary"
        ? async (input, context) => {
            bindGitHubRequest(method, input, context);
            const request = redirected(core, method, input);
            const node = target(method, request);

            if (!node) {
              await refuseFrozen(core, method, request);

              return settled(core, method, unary(handler, request, context));
            }

            if (WORKER_SETTINGS.has(method.name)) return sendWorkerSetting(core, method, request, node, context.signal);

            const home = await peerOf(core, node, method, request);
            refuseRemoteBranchSwitch(method, core.computers?.capabilities(home) ?? []);
            refuseRemoteWorktree(method, request, core.computers?.capabilities(home).includes(REMOTE_WORKTREES));

            const response = await linkedWrite(method, request, home, "sender", () =>
              single(
                forward(
                  core,
                  home,
                  method,
                  request,
                  AbortSignal.any([context.signal, AbortSignal.timeout(unaryTimeout(method))]),
                ),
              ),
            );

            await auditHomeAction(core, "sent", method, response, home);

            return response;
          }
        : async function* (input, context) {
            const request = redirected(core, method, input);
            const node = target(method, request);

            if (!node) {
              await refuseFrozen(core, method, request);
              yield* stream(handler, request, context);
            } else yield* forward(core, await peerOf(core, node, method, request), method, request, context.signal);
          };
  }

  const routedOne = handlers;

  const overrides: Partial<UiHandlers> = {
    readBotExchange: async (request) => {
      const response = await core.linkedAgents.exchangeView(create(bots.ReadBotExchangeRequestSchema, request));

      const self = core.computers && nodeRef(core.computers.hello().nodeId);

      if (self)
        mapIds(bots.ReadBotExchangeResponseSchema, response, (id) => (splitId(id).node === self ? splitId(id).id : id));

      return response;
    },
    getOverview: async (request, context) => {
      const [result, snapshot, remote] = await Promise.all([
        local.getOverview(request, context),
        core.computers?.snapshot(),
        gather<ui.GetOverviewResponse>(core, "GetOverview", request, context.signal),
      ]);

      const overview = create(ui.GetOverviewResponseSchema, result);

      absorb(overview, remote, await localProjectIds(core));
      overview.computers = snapshot?.peers ?? [];

      return overview;
    },
    listThreads: async (request, context) => {
      // A plain project id gathers too: a shared project has threads on every computer.
      if (target(methodNamed("ListThreads")!, request))
        // SAFETY: This entry was built from the ListThreads descriptor above.
        return unary(routedOne["listThreads"]!, request, context) as Promise<ui.ListThreadsResponse>;

      const [result, remote] = await Promise.all([
        local.listThreads(request, context),
        gather<ui.ListThreadsResponse>(core, "ListThreads", request, context.signal),
      ]);

      const list = create(ui.ListThreadsResponseSchema, result);

      for (const other of remote) list.threads.push(...other.threads);

      return list;
    },
    listModels: async (request, context) => {
      if (target(methodNamed("ListModels")!, request))
        // SAFETY: This entry was built from the ListModels descriptor above.
        return unary(routedOne["listModels"]!, request, context) as Promise<ui.ListModelsResponse>;

      // A plain worker id is this computer's worker: no other home has its catalog.
      if (request.workerId) return local.listModels(request, context);

      const [result, remote] = await Promise.all([
        local.listModels(request, context),
        gather<ui.ListModelsResponse>(core, "ListModels", request, context.signal),
      ]);

      const list = create(ui.ListModelsResponseSchema, result);

      for (const other of remote) list.workers.push(...other.workers);

      return list;
    },
    ...executionLists(core, local, routedOne),
    // The archive is paged per computer; other computers' archived threads stay on them in this stage.
    listArchivedThreads: (request, context) => {
      const projectIds = request.projectIds.filter((id) => !splitId(id).node);

      if (request.projectIds.length && !projectIds.length) return create(ui.ListArchivedThreadsResponseSchema);

      return local.listArchivedThreads(
        create(ui.ListArchivedThreadsRequestSchema, { ...request, projectIds }),
        context,
      );
    },
    watchOverview: (request, context) => watchOverview(core, own, request, context),
    manageUpdates: linkedManageUpdates(core, local),
    ...splitOverrides(core, local),
  };

  return { ...local, ...handlers, ...overrides };
}

/** Serves a linked computer's call with this computer's own handlers: no routing onward, no aggregation. */
export function remoteServe(local: UiHandlers, core?: GatewayCore): RemoteServe {
  // SAFETY: Each entry is invoked with the request decoded by the matching GatewayService descriptor.
  const own = local as Record<string, Handler>;

  return async function* (method, request, signal, peerNodeId) {
    if (peerNodeId) refuseRemoteBranchSwitch(method, core?.computers?.hello().capabilities ?? []);

    if (peerNodeId)
      refuseRemoteWorktree(method, request, core?.computers?.hello().capabilities.includes(REMOTE_WORKTREES));

    if (core) await refuseFrozen(core, method, request);

    if (method.name === "CallAgentBus") {
      if (!core || !peerNodeId) throw new ConnectError("Linked agent bus unavailable", Code.Unimplemented);

      try {
        yield create(link.LinkedAgentResultSchema, {
          resultJson: JSON.stringify(
            await core.linkedAgents.receive(peerNodeId, linkedMessage(link.LinkedAgentCallSchema, request)),
          ),
        });
      } catch (error) {
        throw toConnectError(error);
      }

      return;
    }

    const ids = core && peerNodeId ? await ConfigIds.for(core, peerNodeId) : undefined;
    await ids?.map(method.input, request, "toLocal", true);

    if (core && peerNodeId) await receiveHomeAction(core, method, request, peerNodeId);

    if (core && peerNodeId && method.name === "CreateThread") {
      const thread = linkedMessage(ui.CreateThreadRequestSchema, request);
      await refuseMissingInstance(core, harnessOf(thread.provider) ?? "", thread.providerProfileId);
    }

    const context = createHandlerContext({
      requestSignal: signal,
      requestHeader: new Headers(peerNodeId ? { "canopy-linked-peer": peerNodeId } : {}),
      responseHeader: new Headers(),
      responseTrailer: new Headers(),
      method,
      service: ui.GatewayService,
      protocolName: "canopy.link",
      requestMethod: "POST",
      url: "",
    });

    const setting = core && peerNodeId && WORKER_SETTINGS.has(method.name) ? peerNodeId : undefined;

    try {
      const answer = setting && (await receiveWorkerSetting(core!, method, request, setting));

      if (method.methodKind === "unary") {
        const response = await linkedWrite(method, request, peerNodeId ?? "", "home", async () =>
          create(method.output, answer || (await unary(own[method.localName]!, request, context))),
        );

        if (core && peerNodeId) await auditHomeAction(core, "received", method, response, peerNodeId);
        await ids?.map(method.output, response, "toGlobal");

        if (setting) await receivedWorkerSetting(core!, method, request, setting);
        yield response;
      } else
        for await (const message of stream(own[method.localName]!, request, context)) {
          // Hub subscribers share messages; id mapping must only change this peer's copy.
          const response = clone(method.output, message);
          await ids?.map(method.output, response, "toGlobal");
          yield response;
        }
    } catch (error) {
      throw toConnectError(error);
    }
  };
}

/** Validation and live UI updates for shared configuration materialized by this gateway. */
export function sharedHost(core: GatewayCore, _local: UiHandlers): SharedHost {
  return {
    validateSettings: async (request) => {
      validateUserSettings(request);

      if (request.threadDefaults) await coreCheckThreadDefaults(core, request.threadDefaults);
    },
    settingsChanged: async (cliChanged) => {
      const settings = (await core.settings()).user;

      if (settings)
        core.hub.publishOverview(
          create(ui.OverviewUpdateSchema, { change: { case: "userSettings", value: settings } }),
        );

      if (cliChanged) await coreCliDefaultsChanged(core);
    },
    providersChanged: async (workerIds) => {
      core.feeds.nudge();
      await coreConfigsChanged(core, workerIds);
      await corePublishModels(core, await coreModelCatalogs(core));
    },
    validateProjectSettings: (defaults) => coreCheckThreadDefaults(core, defaults),
    environmentChanged: async () => {
      await core.environment.changed();
    },
    connectorsChanged: async () => {
      await core.environment.changed();
      core.feeds.nudge(true);
    },
    workerRecordsChanged: () =>
      core.hub.publishOverview(
        create(ui.OverviewUpdateSchema, { change: { case: "workerRecordsChanged", value: true } }),
      ),
    projectsChanged: async () => {
      const archived =
        (await core.computers?.store.query<{ id: string; name: string }>(
          "SELECT id::text,name FROM projects WHERE owner_user_id=$1::uuid AND archived_at IS NOT NULL AND kind='project'",
          [core.computers.store.owner],
        )) ?? [];

      for (const project of archived) {
        const threads = await core.listThreads(project.id, true);

        for (const thread of threads.filter((t) => !t.parentThreadId)) await core.setThreadArchived(thread.id, true);
        core.hub.publishOverview(
          create(ui.OverviewUpdateSchema, {
            change: {
              case: "project",
              value: {
                ...project,
                kind: "project",
                archivedAt: timestampFromDate(new Date()),
              },
            },
          }),
        );
      }

      for (const project of (await core.overview()).projects)
        core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));

      for (const settings of (await core.settings()).projects)
        core.hub.publishOverview(
          create(ui.OverviewUpdateSchema, { change: { case: "projectSettings", value: settings } }),
        );
    },
  };
}
