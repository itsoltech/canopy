import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { delegatedThreadCounts, type DelegatedThreadCounts } from "./bot-delegated-threads.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

export async function executingBotIds(core: GatewayCore): Promise<ReadonlySet<string>> {
  const { instanceId, userId } = core[coreState].options;
  const executions = await core.bots.run((s) => s.executions(userId));

  return new Set(
    executions
      .filter(({ instance_id, worker_id, epoch }) => {
        if (instance_id !== instanceId) return true;
        const connection = core.link.connections.get(worker_id);

        // Local disconnects are visible before the guarded database update commits.
        return connection?.isOpen && connection.registrationEpoch === BigInt(epoch);
      })
      .map(({ bot_id }) => bot_id),
  );
}

export async function listBotSummaries(
  core: GatewayCore,
  includeArchived: boolean,
  executing?: ReadonlySet<string>,
  delegated?: ReadonlyMap<string, DelegatedThreadCounts>,
) {
  const [listed, active, counts] = await Promise.all([
    core.bots.list(includeArchived),
    executing ?? executingBotIds(core),
    delegated ?? delegatedThreadCounts(core),
  ]);

  return listed.map((bot) => {
    const value = counts.get(bot.id);

    return {
      ...bot,
      executing: !bot.archived && active.has(bot.id),
      delegatedThreads: value && create(bots.BotDelegatedThreadsSchema, value),
    };
  });
}
