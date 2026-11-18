import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { selectScheduleWorkspace } from "@canopy/domain";
import { ui } from "@canopy/contracts";
import { GatewayStore } from "./store.ts";
import { resolveScope } from "../worktrees/settings.ts";
import type { ScheduleRow } from "./agent-bus-types.ts";
import { lockedOwnerModule } from "./module-access.ts";

type Candidate = { id: string; worker_id: string; owner_user_id: string; project_kind: string; load: number };

/** Reserve a placement before the Git RPC, then release the transaction. Reclaims of this occurrence
 * keep its checkout and request ID, even when a different gateway now owns the scheduler lease. */
export function reserveScheduleWorkspace(
  sql: SqlClient.SqlClient,
  schedule: ScheduleRow,
  spec: ui.NewThreadSchedule,
  candidates: readonly Candidate[],
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const preferred = selectScheduleWorkspace(spec.placement, candidates, schedule.placement_cursor);

      if (!preferred) return;
      const owner = preferred.owner_user_id;

      if (!(yield* lockedOwnerModule(sql, owner, "threads"))) return;

      const claimed = yield* sql`SELECT id FROM schedules WHERE id=${schedule.id}::uuid
      AND status='active' AND version=${schedule.version} AND lease_owner=${schedule.lease_owner}
      AND lease_until=${schedule.lease_until} AND next_run_at=${schedule.next_run_at} FOR UPDATE`;

      if (!claimed.length) return;

      if (spec.workspaceMode !== ui.WorkspaceMode.NEW_WORKTREE && spec.workspaceMode !== ui.WorkspaceMode.UNSPECIFIED)
        return { placement: preferred, owner, worktreeId: "", cwd: "", mode: spec.workspaceMode };

      const occurrence = schedule.occurrence_at ?? schedule.next_run_at;

      const saved = (yield* sql<{ workspace_id: string; worktree_id: string; path: string | null; ready: boolean }>`
      SELECT p.workspace_id, p.worktree_id, w.path, p.retry_after<=now() AS ready
      FROM schedule_worktree_preparations p
      JOIN project_workspaces pw ON pw.id=p.workspace_id AND pw.archived_at IS NULL
      JOIN workers host ON host.id=pw.worker_id AND host.archived_at IS NULL AND host.revoked_at IS NULL
      LEFT JOIN worktrees w ON w.id=p.worktree_id
      WHERE p.schedule_id=${schedule.id}::uuid AND p.schedule_version=${schedule.version}
        AND p.occurrence_at=${occurrence} AND w.removed_at IS NULL`)[0];

      const placement = saved ? candidates.find((c) => c.id === saved.workspace_id) : preferred;

      if (!placement) return;

      if (!saved && spec.workspaceMode === ui.WorkspaceMode.UNSPECIFIED) {
        const store = yield* GatewayStore;
        const scopes = yield* store.worktreeScopes(owner, schedule.project_id, placement.worker_id);

        const mode =
          placement.project_kind === "scratch"
            ? ui.WorkspaceMode.CHECKOUT
            : resolveScope(scopes, schedule.project_id, placement.worker_id).effective.defaultMode;

        if (mode !== ui.WorkspaceMode.NEW_WORKTREE)
          return { placement, owner, worktreeId: "", cwd: "", mode: ui.WorkspaceMode.CHECKOUT };
      }

      if (saved?.path)
        return {
          placement,
          owner,
          worktreeId: saved.worktree_id,
          cwd: saved.path,
          mode: ui.WorkspaceMode.NEW_WORKTREE,
        };

      if (saved && !saved.ready) return;

      const worktreeId = saved?.worktree_id ?? Bun.randomUUIDv7();
      yield* sql`INSERT INTO schedule_worktree_preparations
      (schedule_id,schedule_version,occurrence_at,workspace_id,worktree_id,retry_after)
      VALUES(${schedule.id}::uuid,${schedule.version},${occurrence},${placement.id}::uuid,${worktreeId}::uuid,now()+interval '2 minutes')
      ON CONFLICT(schedule_id) DO UPDATE SET schedule_version=excluded.schedule_version,occurrence_at=excluded.occurrence_at,
        workspace_id=excluded.workspace_id,worktree_id=excluded.worktree_id,retry_after=excluded.retry_after`;

      return { placement, owner, worktreeId, cwd: "", mode: ui.WorkspaceMode.NEW_WORKTREE };
    }),
  );
}
