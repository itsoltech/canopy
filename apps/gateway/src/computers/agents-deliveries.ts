import { qualifyId } from "@canopy/domain/computers";

import { agentsState, type Reference } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";

export interface AgentsDeliveriesMethods {
  tick(): Promise<void>;
}

export const agentsDeliveriesMethods: AgentsDeliveriesMethods = {
  async tick(this: LinkedAgents): Promise<void> {
    if (this[agentsState].ticking || !this.core.computers) return;
    this[agentsState].ticking = true;

    try {
      const questions = await this.query<
        Reference & { request_id: string; request: unknown; tool_name: string; created_at: Date }
      >(
        `SELECT c.*,i.id AS request_id,i.request,i.tool_name,i.created_at FROM computer_agent_calls c
        JOIN interaction_requests i ON i.thread_id=c.target_id AND i.status='pending' AND i.routed_to='parent'
        WHERE c.owner_user_id=$1::uuid AND c.direction='incoming' AND c.parent_link AND NOT c.detached
        AND NOT EXISTS(SELECT 1 FROM computer_agent_events e WHERE e.owner_user_id=c.owner_user_id AND e.peer_node_id=c.peer_node_id AND e.call_id=c.call_id AND e.event_id=i.id)`,
        [this.owner],
      );

      for (const q of questions) {
        // Claim once. No retry after an unavailable parent: the human can still answer at the home UI.
        const claimed = await this.query(
          `INSERT INTO computer_agent_events(owner_user_id,peer_node_id,call_id,event_id) VALUES ($1::uuid,$2,$3::uuid,$4::uuid) ON CONFLICT DO NOTHING RETURNING event_id`,
          [this.owner, q.peer_node_id, q.call_id, q.request_id],
        );

        if (!claimed.length) continue;

        try {
          const peer = await this.core.computers.computer(q.peer_node_id);

          if (
            !this.core.computers.canCall(q.peer_node_id) ||
            Number(peer?.statusSinceMs ?? 0n) > new Date(q.created_at).getTime()
          )
            continue;
          const requestId = qualifyId(q.request_id, this.core.computers.hello().nodeId);
          await this.call(
            q.peer_node_id,
            "question",
            { id: q.actor_id, kind: q.actor_kind, hops: q.hops + 1, name: "" },
            q.call_id,
            {
              event: q.request_id,
              text: `[canopy] Your child on ${this.core.computers.hello().name} asks (${q.tool_name}).\nthread_id: ${qualifyId(q.target_id, this.core.computers.hello().nodeId)}\nrequest_id: ${requestId}\n${JSON.stringify(q.request).slice(0, 8000)}\nAnswer with answer_interaction using these ids. The user can answer in the UI instead.`,
            },
          );
        } catch {
          /* no queue across an unavailable link */
        }
      }

      const due = await this.query<Reference & { status: string; text: string; completed_at: Date }>(
        `SELECT c.*,coalesce(t.status,b.status) AS status,coalesce(t.completed_at,b.finished_at) AS completed_at,
        CASE WHEN c.target_kind='bot' THEN (SELECT m.text FROM bot_messages m WHERE m.turn_id=c.target_turn_id AND message_key='answer' LIMIT 1)
        ELSE (SELECT i.content->'agentMessage'->>'text' FROM thread_items i WHERE i.turn_id=c.target_turn_id AND i.type='agent_message' ORDER BY i.last_seq DESC LIMIT 1) END AS text
        FROM computer_agent_calls c LEFT JOIN turns t ON c.target_kind='thread' AND t.id=c.target_turn_id
        LEFT JOIN bot_turns b ON c.target_kind='bot' AND b.id=c.target_turn_id
        WHERE c.owner_user_id=$1::uuid AND c.direction='incoming' AND NOT c.detached AND c.notify AND c.report_status='pending'
        AND coalesce(t.status,b.status) IN ('completed','failed','interrupted','cancelled')`,
        [this.owner],
      );

      for (const r of due) {
        let status = "dropped";

        try {
          const peer = await this.core.computers.computer(r.peer_node_id);

          if (
            !this.core.computers.canCall(r.peer_node_id) ||
            Number(peer?.statusSinceMs ?? 0n) > new Date(r.completed_at).getTime()
          )
            throw new Error("Parent was unavailable when the turn ended");
          await this.call(
            r.peer_node_id,
            "report",
            { id: r.actor_id, kind: r.actor_kind, hops: r.hops + 1, name: "" },
            r.call_id,
            {
              text: `[canopy] ${r.target_kind} ${qualifyId(r.target_id, this.core.computers.hello().nodeId)} on ${this.core.computers.hello().name} ended: ${r.status}.\n${(r.text || "(no message)").slice(0, 20000)}`,
              event: r.target_turn_id,
            },
          );
          status = "delivered";
        } catch {
          /* no outgoing queue: an unavailable parent never receives a delayed report */
        }

        await this.query(
          "UPDATE computer_agent_calls SET report_status=$4 WHERE owner_user_id=$1::uuid AND peer_node_id=$2 AND call_id=$3::uuid AND direction='incoming'",
          [this.owner, r.peer_node_id, r.call_id, status],
        );
      }
    } finally {
      this[agentsState].ticking = false;
    }
  },
};
