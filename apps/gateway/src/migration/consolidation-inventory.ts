import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { one } from "../store/errors.ts";
import { consolidationBlockers } from "./consolidation-blockers.ts";

type Source = { nodeId: string; ownerUserId: string; name: string };

type Kind = "project" | "workspace" | "worker" | "thread" | "bot" | "schedule" | "attachment";

// A source row identity for the future import ledger. Qualified client IDs use a shorter node ref.
function keyed<K extends Kind, Row extends { id: string }>(source: Source, kind: K, rows: readonly Row[]) {
  return rows.map((row) => ({ ...row, key: [source.nodeId, source.ownerUserId, kind, row.id] as const }));
}

function homeRecords(sql: SqlClient.SqlClient, source: Source) {
  return Effect.gen(function* () {
    const owner = source.ownerUserId;

    const projects = yield* sql<{ id: string; slug: string; archived: boolean; configDeleted: boolean }>`
      SELECT id,slug,archived_at IS NOT NULL AS archived,config_deleted AS "configDeleted"
      FROM projects WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const workspaces = yield* sql<{ id: string; projectId: string; workerId: string | null; archived: boolean }>`
      SELECT pw.id,p.id AS "projectId",w.id AS "workerId",pw.archived_at IS NOT NULL AS archived
      FROM project_workspaces pw JOIN projects p ON p.id=pw.project_id
      LEFT JOIN workers w ON w.id=pw.worker_id AND (w.owner_user_id=p.owner_user_id OR w.owner_user_id IS NULL)
      WHERE p.owner_user_id=${owner}::uuid ORDER BY pw.id`;

    // Retained local tombstones are part of FK mapping. Moved-away rows and frozen moves
    // are handled through verified redirects and unfinished-move blockers.
    const threads = yield* sql<{
      id: string;
      projectId: string | null;
      workerId: string | null;
      workspaceId: string | null;
      rootThreadId: string | null;
      parentThreadId: string | null;
      remoteParentRef: string | null;
      remoteParentKind: "thread" | "bot" | null;
      remoteParentDetached: boolean;
      status: string;
      deleted: boolean;
      purged: boolean;
      hasProviderSession: boolean;
    }>`SELECT t.id,p.id AS "projectId",w.id AS "workerId",pw.id AS "workspaceId",
      root.id AS "rootThreadId",parent.id AS "parentThreadId",t.remote_parent_ref AS "remoteParentRef",
      t.remote_parent_kind AS "remoteParentKind",t.remote_parent_detached AS "remoteParentDetached",
      t.status,t.deleted_at IS NOT NULL AS deleted,t.purged_at IS NOT NULL AS purged,
      t.provider_thread_id IS NOT NULL AS "hasProviderSession"
      FROM threads t
      LEFT JOIN projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id
      LEFT JOIN project_workspaces pw ON pw.id=t.workspace_id AND pw.project_id=p.id
      LEFT JOIN workers w ON w.id=t.worker_id AND (w.owner_user_id=t.owner_user_id OR w.owner_user_id IS NULL)
      LEFT JOIN threads root ON root.id=t.root_thread_id AND root.owner_user_id=t.owner_user_id
      LEFT JOIN threads parent ON parent.id=t.parent_thread_id AND parent.owner_user_id=t.owner_user_id
      WHERE t.owner_user_id=${owner}::uuid AND t.moved_to IS NULL ORDER BY t.id`;

    const bots = yield* sql<{ id: string; workerId: string | null; archived: boolean; deleted: boolean }>`
      SELECT b.id,w.id AS "workerId",b.archived_at IS NOT NULL AS archived,b.deleted_at IS NOT NULL AS deleted
      FROM bots b LEFT JOIN workers w ON w.id::text=b.configuration->>'workerId'
        AND (w.owner_user_id=b.owner_user_id OR w.owner_user_id IS NULL)
      WHERE b.owner_user_id=${owner}::uuid AND b.moved_to IS NULL ORDER BY b.id`;

    const referencedWorkers = [...new Set([...workspaces, ...threads, ...bots].flatMap((r) => r.workerId ?? []))];

    const workers = yield* sql<{ id: string; name: string; shared: boolean; revoked: boolean; archived: boolean }>`
      SELECT id,name,owner_user_id IS NULL AS shared,revoked_at IS NOT NULL AS revoked,archived_at IS NOT NULL AS archived
      FROM workers WHERE owner_user_id=${owner}::uuid
        OR (owner_user_id IS NULL AND id=ANY(${referencedWorkers}::uuid[])) ORDER BY id`;

    const schedules = yield* sql<{
      id: string;
      projectId: string;
      threadId: string | null;
      workspaceId: string | null;
      status: string;
    }>`SELECT s.id,p.id AS "projectId",t.id AS "threadId",pw.id AS "workspaceId",s.status
      FROM schedules s JOIN projects p ON p.id=s.project_id
      LEFT JOIN threads t ON t.id=s.thread_id AND t.owner_user_id=p.owner_user_id AND t.moved_to IS NULL
      LEFT JOIN project_workspaces pw ON pw.id::text=s.new_thread->>'workspaceId' AND pw.project_id=p.id
      WHERE p.owner_user_id=${owner}::uuid AND (s.thread_id IS NULL OR t.id IS NOT NULL) ORDER BY s.id`;

    const attachments = yield* sql<{ id: string; threadId: string | null; botId: string | null }>`
      SELECT a.id,t.id AS "threadId",b.id AS "botId"
      FROM attachments a
      LEFT JOIN threads t ON t.id=a.thread_id AND t.owner_user_id=a.owner_user_id AND t.moved_to IS NULL
      LEFT JOIN bots b ON b.id=a.bot_id AND b.owner_user_id=a.owner_user_id AND b.moved_to IS NULL
      WHERE a.owner_user_id=${owner}::uuid AND (a.thread_id IS NULL OR t.id IS NOT NULL)
        AND (a.bot_id IS NULL OR b.id IS NOT NULL) ORDER BY a.id`;

    return {
      projects: keyed(source, "project", projects),
      workspaces: keyed(source, "workspace", workspaces),
      workers: keyed(
        source,
        "worker",
        workers.filter((w) => !w.shared),
      ),
      threads: keyed(source, "thread", threads),
      bots: keyed(source, "bot", bots),
      schedules: keyed(source, "schedule", schedules),
      attachments: keyed(source, "attachment", attachments),
      sharedWorkers: workers.filter((w) => w.shared),
    };
  });
}

function affectedPeers(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    nodeId: string;
    name: string;
    viaNodeId: string | null;
    lastKnownStatus: string;
    mirroredThreads: number;
    mirroredBots: number;
    mirroredWorkers: number;
  }>`SELECT p.node_id AS "nodeId",coalesce(nullif(p.display_name,''),p.name) AS name,
      p.via_node_id AS "viaNodeId",p.status AS "lastKnownStatus",
      (SELECT count(*)::int FROM computer_mirror_threads t JOIN computer_mirror_state s USING(owner_user_id,origin_node_id,generation)
        WHERE t.owner_user_id=p.owner_user_id AND t.origin_node_id=p.node_id) AS "mirroredThreads",
      (SELECT count(*)::int FROM computer_mirror_bots b
        WHERE b.owner_user_id=p.owner_user_id AND b.origin_node_id=p.node_id) AS "mirroredBots",
      (SELECT count(*)::int FROM config_items c
        WHERE c.owner_user_id=p.owner_user_id AND c.home_node_id=p.node_id AND c.kind='worker') AS "mirroredWorkers"
    FROM computer_peers p WHERE p.owner_user_id=${owner}::uuid ORDER BY p.node_id`;
}

/** Source metadata for an already authorized owner. The snapshot can go stale immediately after the read. */
export function consolidationPreflight(ownerUserId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

        const source = yield* one(
          yield* sql<Source>`SELECT node_id AS "nodeId",owner_user_id AS "ownerUserId",name
            FROM computer_identity WHERE owner_user_id=${ownerUserId}::uuid`,
          "Linked computer identity",
        );

        const { sharedWorkers, ...home } = yield* homeRecords(sql, source);
        const peers = yield* affectedPeers(sql, source.ownerUserId);
        const blockers = yield* consolidationBlockers(sql, source.ownerUserId);

        const redirects = yield* sql<{
          kind: "thread" | "bot";
          itemId: string;
          fromNodeId: string;
          homeNodeId: string;
          basis: "local_move" | "former_home";
        }>`SELECT kind,item_id AS "itemId",from_node_id AS "fromNodeId",home_node_id AS "homeNodeId",basis
          FROM computer_redirects WHERE owner_user_id=${source.ownerUserId}::uuid ORDER BY kind,item_id,from_node_id`;

        return { source, home, sharedWorkers, peers, redirects, blockers };
      }),
    );
  });
}
