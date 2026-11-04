import { create, toJson, type DescMessage, type JsonValue, type Message } from "@bufbuild/protobuf";

import { bots, ui } from "@canopy/contracts";

import { AGENT_BUS } from "@canopy/domain/computers";

import type { LinkedAgents } from "./agents.ts";
import { linkedMessage, methodNamed, qualify } from "./remote.ts";

export interface AgentsCatalogMethods {
  catalog(): Promise<JsonValue[]>;
  overview(): Promise<ui.GetOverviewResponse>;
}

export const agentsCatalogMethods: AgentsCatalogMethods = {
  async catalog(this: LinkedAgents): Promise<JsonValue[]> {
    const computers = this.core.computers;

    if (!computers) return [];
    const peers = (await computers.snapshot()).peers;

    const results = await Promise.all(
      peers.map(async (p) => {
        const machine = { node_id: p.nodeId, machine: p.displayName || p.name, status: p.status };

        if (!computers.reachable().includes(p.nodeId))
          return { ...machine, error: (await computers.unavailable(p.nodeId)).rawMessage };

        if (!p.capabilities.includes(AGENT_BUS))
          return { ...machine, error: `${machine.machine} needs an update for linked bots and agents` };

        const get = async <D extends DescMessage>(name: string, request: Message, output: D) => {
          const method = methodNamed(name)!;

          for await (const result of computers.remote(p.nodeId, method, request, AbortSignal.timeout(3000))) {
            qualify(method.output, result, p.nodeId);

            return linkedMessage(output, result);
          }

          return undefined;
        };

        try {
          const [overview, botList, models] = await Promise.all([
            get("GetOverview", create(ui.GetOverviewRequestSchema), ui.GetOverviewResponseSchema),
            get("ListBots", create(bots.ListBotsRequestSchema), bots.ListBotsResponseSchema),
            get("ListModels", create(ui.ListModelsRequestSchema), ui.ListModelsResponseSchema),
          ]);

          return {
            ...machine,
            projects: overview!.projects.map((v) => toJson(ui.ProjectSchema, v)),
            workers: overview!.workers.map((w) => ({ worker_id: w.id, name: w.name, online: w.online })),
            bots: botList!.bots.map((b) => ({ bot_id: b.id, name: b.configuration?.name ?? "Bot" })),
            models: toJson(ui.ListModelsResponseSchema, models!),
          };
        } catch {
          return { ...machine, error: "Computer unavailable; try again while connected" };
        }
      }),
    );

    return results;
  },

  async overview(this: LinkedAgents): Promise<ui.GetOverviewResponse> {
    const own = await this.core.overview();
    const computers = this.core.computers;

    if (!computers) return own;

    for (const node of computers.reachable()) {
      if (!computers.capabilities(node).includes(AGENT_BUS)) continue;

      try {
        for await (const response of computers.remote(
          node,
          methodNamed("GetOverview")!,
          create(ui.GetOverviewRequestSchema),
          AbortSignal.timeout(3000),
        )) {
          qualify(ui.GetOverviewResponseSchema, response, node);
          const overview = linkedMessage(ui.GetOverviewResponseSchema, response);
          own.workers.push(...overview.workers);
          own.projects.push(...overview.projects);
        }
      } catch {
        /* disconnected while gathering */
      }
    }

    return own;
  },
};
