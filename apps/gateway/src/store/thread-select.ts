import { DISPATCHED } from "./turn-select.ts";

/** Characters of a side thread's last message in ui.Thread (the subagent card in the parent's timeline). */
const LAST_MESSAGE_PREVIEW = 600;

/** Characters read for a notification preview, before markdown and secrets are removed (thread-notice.ts). */
const NOTICE_SOURCE = 2000;

// List consumers need the UI row, never agent instructions, handoff or title-generation context.
const LIST_COLUMNS = `t.id,t.project_id,t.owner_user_id,t.kind,t.parent_thread_id,t.remote_parent_ref,
  t.remote_parent_kind,t.remote_parent_detached,t.root_thread_id,t.depth,t.origin,t.schedule_id,t.schedule_name,
  t.schedule_run,t.interaction_route,t.agent_id,t.runtime,t.provider,t.provider_profile_id,t.worker_id,
  t.workspace_id,t.cwd,t.fork_source_thread_id,t.fork_after_turn_id,t.status,t.status_detail,t.title,
  t.title_source,t.title_revision,t.title_requested,t.last_seq,t.created_at,t.archived_at,t.archived_by,
  t.archived_by_thread_id,t.deleted_at,t.worktree_id,NULL::text AS provider_thread_id,''::text AS title_context,
  t.newest_pull_request,t.pull_request_count,t.pull_request_revision,t.list_settings AS settings`;

export const listThreadSelect = (where: string, extraColumns = "") => threadSelect(where, extraColumns, true);

/** The thread columns (ThreadRow) with the joined ones, for `FROM threads t` and the given clauses. */
export const threadSelect = (where: string, extraColumns = "", metadata = false) => `
          -- An asynchronous question (wait=false) needs the user only once the agent has stopped working.
          SELECT ${metadata ? LIST_COLUMNS : "t.*"}, to_char(t.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archived_at_key,
                 (SELECT p.kind FROM projects p WHERE p.id = t.project_id) AS project_kind, ${extraColumns} (SELECT count(*) FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND (i.question_wait IS DISTINCT FROM false OR t.status NOT IN ('running', 'creating'))) AS pending_interactions,
                 EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued' AND ${DISPATCHED}) AS turn_starting,
                 greatest(t.created_at, (SELECT greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at))
                   FROM turns u WHERE u.thread_id = t.id
                   ORDER BY greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at)) DESC LIMIT 1)) AS last_activity_at,
                 (SELECT g.status FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled') LIMIT 1) AS goal_status,
                 (SELECT count(*) FROM thread_items b WHERE b.thread_id = t.id AND b.type = 'background_task' AND b.status = 'in_progress') AS background_tasks,
                 -- The unseen result with what a notification shows: the turn's last answer or its error.
                 (SELECT json_build_object('status', u.status, 'interrupt_source', u.interrupt_source, 'error', left(u.error, ${NOTICE_SOURCE}),
                         'message', (SELECT left(m.content->'agentMessage'->>'text', ${NOTICE_SOURCE}) FROM thread_items m
                                      WHERE m.thread_id = t.id AND m.turn_id = u.id AND m.type = 'agent_message' ORDER BY m.first_seq DESC LIMIT 1))
                    FROM turns u
                   WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                     AND u.last_seq > coalesce((SELECT r.seen_seq FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), 0)
                   ORDER BY u.last_seq DESC LIMIT 1) AS unseen_turn,
                 (SELECT json_build_object('kind', i.kind, 'tool', i.tool_name, 'request', i.request) FROM interaction_requests i
                   WHERE i.thread_id = t.id AND i.status = 'pending' AND (i.question_wait IS DISTINCT FROM false OR t.status NOT IN ('running', 'creating'))
                   ORDER BY i.created_at DESC LIMIT 1) AS notice_interaction,
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
                                           'detached_commit', wt.detached_commit, 'branch_source', wt.branch_source, 'external', wt.external)
                    FROM worktrees wt WHERE wt.id = t.worktree_id) AS worktree,
                 (SELECT json_build_object('branch', h.branch, 'detached_commit', h.detached_commit)
                    FROM checkout_heads h WHERE t.worktree_id IS NULL AND h.workspace_id = t.workspace_id) AS checkout_head,
                 (SELECT json_build_object('agent_cli', ti.agent_cli, 'mode', ti.mode, 'imported_at', ti.imported_at)
                    FROM thread_imports ti WHERE ti.thread_id = t.id) AS imported
            FROM threads t ${where}`;
