import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { linkedModulesConnected } from "./agents-module-access.ts";
import type { LinkedAgents } from "./agents.ts";

const snapshots = new WeakMap<LinkedAgents, Map<string, { at: number; cards: Promise<bots.BotApproval[]> }>>();

/** Batch only pending requests through the existing owner-authenticated UI route. */
export async function linkedBotThreadApprovals(host: LinkedAgents, botId: string) {
  if (!host.core.computers || !(await linkedModulesConnected(host))) return [];
  let cache = snapshots.get(host);

  if (!cache) snapshots.set(host, (cache = new Map()));
  const previous = cache.get(botId);

  if (previous && Date.now() - previous.at < 1000) return previous.cards;
  const current = { at: Date.now(), cards: readLinkedApprovals(host, botId) };
  cache.set(botId, current);

  try {
    const cards = await current.cards;

    // A positive result needs a fresh home decision on the next read after a module change.
    if (cards.length && cache.get(botId) === current) cache.delete(botId);

    return cards;
  } catch (error) {
    if (cache.get(botId) === current) cache.delete(botId);
    throw error;
  }
}

async function readLinkedApprovals(host: LinkedAgents, botId: string) {
  const refs = await host.query<{ peer_node_id: string; target_id: string }>(
    `SELECT DISTINCT c.peer_node_id,c.target_id FROM computer_agent_calls c JOIN bots b ON b.id=c.actor_id
     WHERE c.owner_user_id=$1::uuid AND b.owner_user_id=c.owner_user_id AND c.actor_kind='bot'
     AND c.direction='outgoing' AND c.operation='spawn' AND c.parent_link AND NOT c.detached AND c.target_kind='thread'
     AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL AND b.id=$2::uuid`,
    [host.owner, botId],
  );

  const reachable = new Set(host.core.computers?.reachable() ?? []);

  const homes = Map.groupBy(
    refs.filter((r) => reachable.has(r.peer_node_id)),
    (r) => r.peer_node_id,
  );

  const cards: bots.BotApproval[] = [];

  for (const [node, threads] of homes) {
    for (let offset = 0; offset < threads.length; offset += 512) {
      const batch = threads.slice(offset, offset + 512).map((r) => qualifyId(r.target_id, node));

      try {
        const pending = await host.ui(
          "ListThreadApprovals",
          create(bots.ListThreadApprovalsRequestSchema, {
            threadId: batch[0]!,
            otherThreadIds: batch.slice(1),
          }),
          bots.ListThreadApprovalsResponseSchema,
        );

        for (const card of pending.approvals) {
          // The request id routes directly to its thread's home; answering never enumerates peers.
          cards.push(create(bots.BotApprovalSchema, { ...card, id: card.requestId, botId }));
        }
      } catch {
        /* Offline/older homes remain answerable from their thread UI. */
      }
    }
  }

  return cards;
}
