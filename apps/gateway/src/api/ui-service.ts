import { guardModuleWork } from "./module-work.ts";
import { usageHandlers } from "./ui-usage.ts";
import { createThreadProgress } from "../core/thread-progress.ts";
import { ui } from "@canopy/contracts";
import { type ConnectRouter, type ServiceImpl } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { routed } from "./routed.ts";
import { attachmentsHandlers } from "./ui-attachments.ts";
import { botChannelHandlers } from "./ui-bot-channels.ts";
import { botsHandlers, botTriggerHandlers } from "./ui-bots.ts";
import { computersHandlers } from "./ui-computers.ts";
import { connectorsHandlers } from "./ui-connectors.ts";
import { mobileHandlers } from "./ui-mobile.ts";
import { networkHandlers } from "./ui-network.ts";
import { projectsHandlers } from "./ui-projects.ts";
import { providersHandlers } from "./ui-providers.ts";
import { queueHandlers } from "./ui-queue.ts";
import { settingsHandlers } from "./ui-settings.ts";
import { threadsHandlers } from "./ui-threads.ts";
import { workersHandlers } from "./ui-workers.ts";
import { agentEnvironmentHandlers } from "./ui-agent-environment.ts";
import { worktreesHandlers } from "./ui-worktrees.ts";
import { importsHandlers } from "./ui-imports.ts";
import { workspaceCopyHandlers } from "./ui-workspace-copy.ts";
import { threadTransferHandlers } from "./ui-thread-transfers.ts";
import { githubHandlers } from "./ui-github.ts";
import { pullRequestHandlers } from "./ui-pull-requests.ts";
import { githubReadHandlers } from "./ui-github-read.ts";
import { githubMutationHandlers } from "./ui-github-mutations.ts";
import { threadPanelHandlers } from "./ui-thread-panel.ts";
import { diagnosticsHandlers } from "./ui-diagnostics.ts";
import { diagnosticsLogHandlers } from "./ui-diagnostics-logs.ts";
import { composerDraftHandlers } from "./ui-composer-drafts.ts";
import { agentToolsHandlers } from "./ui-agent-tools.ts";
import { withDraftDelivery } from "../drafts/delivery.ts";
import { liveTurnPermissionHandlers } from "./ui-live-permissions.ts";
import { memoryHandlers } from "../memory/ui.ts";
import { reflectionHandlers } from "../memory/reflection-ui.ts";

export { toConnectError } from "./ui-errors.ts";

export type UiHandlers = ServiceImpl<typeof ui.GatewayService>;

/** GatewayService for the UI (docs/ui-api.md), with threads of linked computers routed to their home (routed.ts). */
export function uiRoutes(core: GatewayCore, options?: { readMaxBytes: number }): (router: ConnectRouter) => void {
  return (router) =>
    router.service(
      ui.GatewayService,
      guardModuleWork(core, withDraftDelivery(core, routed(core, uiHandlers(core)))),
      options,
    );
}

/** Writes that can change a bot summary, a connector or a proxy: the owner feed compares at once afterwards. */
const FEED_WRITE = /Bot|Connector|Prox/;
const READ = /^(List|Get|Watch|Read|Search|Preview)|Draft/;

/** Nudges the owner feed after successful writes, so other clients see them within ~100 ms, not 2 s. */
function withFeedNudges(core: GatewayCore, handlers: UiHandlers): UiHandlers {
  // SAFETY: Entries are replaced by wrappers that call the same handler with the same arguments.
  const own = handlers as Record<string, (...args: never[]) => object>;

  for (const method of ui.GatewayService.methods) {
    if (method.methodKind !== "unary" || !FEED_WRITE.test(method.name) || READ.test(method.name)) continue;
    const handler = own[method.localName];

    if (!handler) continue;

    // Grants and moves change which accounts a bot must reconnect: compare every bot.
    const full =
      /^(SaveConnectorAccount|SetConnectorAccess|SetThreadConnectorGrant|DeleteConnectorAccount|DisconnectConnector)$|Move/.test(
        method.name,
      );

    own[method.localName] = async (...args: never[]) => {
      const result = await handler(...args);
      core.feeds.nudge(full);

      return result;
    };
  }

  return handlers;
}

/** This computer's own GatewayService. Thin: validation and state live in the core and the store. */
export function uiHandlers(core: GatewayCore): UiHandlers {
  return withFeedNudges(core, {
    ...memoryHandlers(core),
    ...reflectionHandlers(core),
    ...usageHandlers(core),
    ...composerDraftHandlers(core),
    ...agentToolsHandlers(core),
    ...diagnosticsHandlers(core),
    ...diagnosticsLogHandlers(core),
    ...agentEnvironmentHandlers(core),
    ...computersHandlers(core),
    ...workersHandlers(core),
    ...threadsHandlers(core),
    createThreadWithProgress: (request, context) => createThreadProgress(core, request, context.signal),
    ...liveTurnPermissionHandlers(core),
    ...mobileHandlers(core),
    ...networkHandlers(core),
    ...connectorsHandlers(core),
    ...threadPanelHandlers(core),
    ...botsHandlers(core),
    ...botTriggerHandlers(core),
    ...botChannelHandlers(core),
    ...projectsHandlers(core),
    ...settingsHandlers(core),
    ...providersHandlers(core),
    ...attachmentsHandlers(core),
    ...queueHandlers(core),
    ...worktreesHandlers(core),
    ...importsHandlers(core),
    ...workspaceCopyHandlers(core),
    ...threadTransferHandlers(core),
    ...githubHandlers(core),
    ...pullRequestHandlers(core),
    ...githubReadHandlers(core),
    ...githubMutationHandlers(core),
  });
}
