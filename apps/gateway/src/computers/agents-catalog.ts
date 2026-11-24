import { create, toJson, type DescMessage, type JsonValue, type Message } from "@bufbuild/protobuf";

import { bots, ui } from "@canopy/contracts";

import { AGENT_BUS } from "@canopy/domain/computers";

import { linkedModulesConnected, requireLinkedModules } from "./agents-module-access.ts";
import type { LinkedAgents } from "./agents.ts";
import { linkedMessage, methodNamed } from "./remote.ts";
import { PEER_CATALOG_BUDGET_MS } from "./timing.ts";
import { forward } from "../api/routed-home.ts";
import { single } from "../api/routed-context.ts";

export interface AgentsCatalogMethods {
  catalog(): Promise<JsonValue[]>;
  overview(access?: "bot-thread"): Promise<ui.GetOverviewResponse>;
}

export const agentsCatalogMethods: AgentsCatalogMethods = {
  async catalog(this: LinkedAgents): Promise<JsonValue[]> {
    const computers = this.core.computers;

    if (!computers) return [];
    const [snapshot, connected] = await Promise.all([computers.snapshot(), linkedModulesConnected(this)]);
    const peers = snapshot.peers;
    // Bot names require live authorization on each home. Give all peers one budget for this
    // optional part of list_agents, so a stalled home cannot delay the local tool result.
    const signal = AbortSignal.timeout(PEER_CATALOG_BUDGET_MS);

    const results = await Promise.all(
      peers.map(async (p) => {
        const machine = { node_id: p.nodeId, machine: p.displayName || p.name, status: p.status };

        const reachable = computers.reachable().includes(p.nodeId);
        const availability = reachable ? {} : { error: (await computers.unavailable(p.nodeId)).rawMessage };

        if (!p.capabilities.includes(AGENT_BUS))
          return { ...machine, error: `${machine.machine} needs an update for linked bots and agents` };

        const get = <D extends DescMessage>(name: string, request: Message, output: D) => {
          const method = methodNamed(name)!;

          const result = computers.reads.read(
            p.nodeId,
            method,
            request,
            (signal) => single(forward(this.core, p.nodeId, method, request, signal)),
            undefined,
            reachable,
          );

          return result ? linkedMessage(output, result) : undefined;
        };

        try {
          const [overview, models] = [
            get("GetOverview", create(ui.GetOverviewRequestSchema), ui.GetOverviewResponseSchema),
            get("ListModels", create(ui.ListModelsRequestSchema), ui.ListModelsResponseSchema),
          ];

          const botList =
            connected && reachable
              ? await this.ui(
                  "ListBots",
                  create(bots.ListBotsRequestSchema, { botThreadAccess: true }),
                  bots.ListBotsResponseSchema,
                  p.nodeId,
                  signal,
                ).catch(() => undefined)
              : undefined;

          return {
            ...machine,
            ...availability,
            loading: reachable && (!overview || !models || (connected && !botList && signal.aborted)),
            projects: overview?.projects.map((v) => toJson(ui.ProjectSchema, { ...v, imageBase64: "" })) ?? [],
            workers:
              overview?.workers.map((w) => ({ worker_id: w.id, name: w.name, online: reachable && w.online })) ?? [],
            bots: botList?.bots.map((b) => ({ bot_id: b.id, name: b.configuration?.name ?? "Bot" })) ?? [],
            models: models ? toJson(ui.ListModelsResponseSchema, models) : {},
          };
        } catch {
          return { ...machine, error: "Computer unavailable; try again while connected" };
        }
      }),
    );

    return results;
  },

  async overview(this: LinkedAgents, access?: "bot-thread"): Promise<ui.GetOverviewResponse> {
    if (access === "bot-thread") await requireLinkedModules(this);
    const own = await this.core.overview();
    const computers = this.core.computers;

    if (!computers) return own;

    for (const peer of (await computers.snapshot()).peers) {
      const node = peer.nodeId;

      if (!computers.capabilities(node).includes(AGENT_BUS)) continue;

      try {
        const method = methodNamed("GetOverview")!;
        const request = create(ui.GetOverviewRequestSchema, { botThreadAccess: access === "bot-thread" });

        const reachable = computers.reachable().includes(node);

        const response =
          access === "bot-thread"
            ? reachable && (await this.ui("GetOverview", request, ui.GetOverviewResponseSchema, node))
            : computers.reads.read(
                node,
                method,
                request,
                (signal) => single(forward(this.core, node, method, request, signal)),
                undefined,
                reachable,
              );

        if (response) {
          const overview = linkedMessage(ui.GetOverviewResponseSchema, response);
          own.workers.push(...overview.workers.map((worker) => ({ ...worker, online: reachable && worker.online })));
          own.projects.push(...overview.projects);
        }
      } catch {
        /* disconnected while gathering */
      }
    }

    return own;
  },
};
