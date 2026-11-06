import { DISPATCHED } from "./turn-select.ts";

/** Characters of a side thread's last message in ui.Thread (the subagent card in the parent's timeline). */
const LAST_MESSAGE_PREVIEW = 600;

/** The thread columns (ThreadRow) with the joined ones, for `FROM threads t` and the given clauses. */
export const threadSelect = (where: string, extraColumns = "") => `
          -- An asynchronous question (wait=false) needs the user only once the agent has stopped working.
          SELECT t.*, (SELECT p.kind FROM projects p WHERE p.id = t.project_id) AS project_kind, ${extraColumns} (SELECT count(*) FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND (i.question_wait IS DISTINCT FROM false OR t.status NOT IN ('running', 'creating'))) AS pending_interactions,
                 EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued' AND ${DISPATCHED}) AS turn_starting,
                 greatest(t.created_at, (SELECT max(greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at)))
                                           FROM turns u WHERE u.thread_id = t.id)) AS last_activity_at,
                 (SELECT g.status FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled') LIMIT 1) AS goal_status,
                 (SELECT count(*) FROM thread_items b WHERE b.thread_id = t.id AND b.type = 'background_task' AND b.status = 'in_progress') AS background_tasks,
                 (SELECT u.status FROM turns u
                   WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                     AND u.last_seq > coalesce((SELECT r.seen_seq FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), 0)
                   ORDER BY u.last_seq DESC LIMIT 1) AS unseen_result,
                 (SELECT u.status FROM turns u WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                   ORDER BY u.ordinal DESC LIMIT 1) AS last_turn_status,
                 coalesce((SELECT r.marked_unread FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), false) AS marked_unread,
                 (SELECT a.title FROM threads a WHERE a.id = t.archived_by_thread_id AND a.deleted_at IS NULL) AS archived_by_thread_title,
                 CASE WHEN t.kind = 'side' THEN
                   (SELECT left(m.content->'agentMessage'->>'text', ${LAST_MESSAGE_PREVIEW}) FROM thread_items m
                     WHERE m.thread_id = t.id AND m.type = 'agent_message' ORDER BY m.first_seq DESC LIMIT 1) END AS last_message,
                 (SELECT (ft.ordinal - (SELECT count(*) FROM turns w WHERE w.thread_id = ft.thread_id AND w.withdrawn IS NOT NULL AND w.ordinal < ft.ordinal))::int
                    FROM turns ft WHERE ft.id = t.fork_after_turn_id) AS fork_after_turn_ordinal,
                 (SELECT json_build_object('id', wt.id, 'branch', wt.branch, 'path', wt.path, 'base_ref', wt.base_ref,
                                           'repo_root', wt.repo_root, 'worker_id', wt.worker_id, 'created_at', wt.created_at, 'removed_at', wt.removed_at,
                                           'detached_commit', wt.detached_commit)
                    FROM worktrees wt WHERE wt.id = t.worktree_id) AS worktree,
                 (SELECT json_build_object('branch', h.branch, 'detached_commit', h.detached_commit)
                    FROM checkout_heads h WHERE t.worktree_id IS NULL AND h.workspace_id = t.workspace_id) AS checkout_head
            FROM threads t ${where}`;
