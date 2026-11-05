import { create } from "@bufbuild/protobuf";
import { bots, computerLink as link, ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { Code, ConnectError, createHandlerContext } from "@connectrpc/connect";
import { linkedMessage, mapIds, methodNamed, SERVED, type RemoteServe } from "../computers/remote.ts";
import type { SharedHost } from "../computers/shared.ts";
import type { GatewayCore } from "../core/core.ts";
import {
  CONFIG_WRITES,
  globalIds,
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
import type { UiHandlers } from "./ui-service.ts";
import { refuseRemoteWorktree } from "../worktrees/remote.ts";
import { validateUserSettings } from "../core/settings-validation.ts";
import { coreCheckThreadDefaults, coreCliDefaultsChanged } from "../core/core-settings.ts";

export function routed(core: GatewayCore, local: UiHandlers): UiHandlers {
  // SAFETY: Each entry is invoked with the request decoded by its own GatewayService method descriptor.
  const own = local as Record<string, Handler>;
  const handlers: Record<string, Handler> = {};

  for (const method of ui.GatewayService.methods) {
    const handler = own[method.localName]!;

    if (!SERVED.has(method.name)) {
      // Settings, credentials and administration stay per computer in this stage.
      const shared = CONFIG_WRITES.has(method.name);
      handlers[method.localName] =
        method.methodKind === "unary"
          ? async (request, context) => {
              refuseForeignAdministration(method, request);
              const response = await unary(handler, request, context);

              if (shared) void core.computers?.configChanged();

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
            const request = redirected(core, method, input);
            const node = target(method, request);

            if (!node) {
              await refuseFrozen(core, method, request);

              return unary(handler, request, context);
            }

            refuseRemoteWorktree(method, request);

            return single(
              forward(
                core,
                await peerOf(core, node, method, request),
                method,
                request,
                AbortSignal.any([context.signal, AbortSignal.timeout(unaryTimeout(method))]),
              ),
            );
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
      const response = create(bots.ReadBotExchangeResponseSchema, {
        messages: await core.linkedAgents.exchange(request.exchangeId),
      });

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

      absorb(overview, remote, globalIds(core));
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

      const [result, remote] = await Promise.all([
        local.listModels(request, context),
        gather<ui.ListModelsResponse>(core, "ListModels", request, context.signal),
      ]);

      const list = create(ui.ListModelsResponseSchema, result);

      for (const other of remote) list.workers.push(...other.workers);

      return list;
    },
    listBots: async (request, context) => {
      const [result, others] = await Promise.all([
        local.listBots(request, context),
        gather<bots.ListBotsResponse>(core, "ListBots", request, context.signal),
      ]);

      const list = create(bots.ListBotsResponseSchema, result);

      for (const other of others) list.bots.push(...other.bots);

      return list;
    },
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
  };

  return { ...local, ...handlers, ...overrides };
}

/** Serves a linked computer's call with this computer's own handlers: no routing onward, no aggregation. */
export function remoteServe(local: UiHandlers, core?: GatewayCore): RemoteServe {
  // SAFETY: Each entry is invoked with the request decoded by the matching GatewayService descriptor.
  const own = local as Record<string, Handler>;

  return async function* (method, request, signal, peerNodeId) {
    if (peerNodeId) refuseRemoteWorktree(method, request);

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

    const context = createHandlerContext({
      requestSignal: signal,
      requestHeader: new Headers(),
      responseHeader: new Headers(),
      responseTrailer: new Headers(),
      method,
      service: ui.GatewayService,
      protocolName: "canopy.link",
      requestMethod: "POST",
      url: "",
    });

    try {
      if (method.methodKind === "unary")
        yield create(method.output, await unary(own[method.localName]!, request, context));
      else
        for await (const message of stream(own[method.localName]!, request, context))
          yield create(method.output, message);
    } catch (error) {
      throw toConnectError(error);
    }
  };
}

/** What shared configuration needs from this gateway: its own handlers, projects with a given id, live UI updates. */
export function sharedHost(core: GatewayCore, local: UiHandlers): SharedHost {
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
    serve: remoteServe(local),
    createProject: async (id, name) => {
      await core.createProject(name, id);
    },
    publish: (value) =>
      core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "sharedConfig", value } })),
  };
}
