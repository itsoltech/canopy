import { createHash } from "node:crypto";
import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConfigAppliedSchema, Provider, ui, type Hello } from "@canopy/contracts";
import { Effect } from "effect";
import { workerLinkCompatible } from "@canopy/domain/release/protocol";
import type { SqlClient } from "effect/sql";
import { one, type Fx } from "./errors.ts";

export interface WorkerStore {
  // users
  ensureUser(email: string, displayName: string): Fx<string>;
  // workers
  authenticateWorker(credential: string): Fx<string | undefined>;
  addWorker(input: { name: string; ownerUserId: string }): Fx<{ workerId: string; credential: string }>;
  workerConnected(workerId: string, instanceId: string, hello: Hello): Fx<void>;
  workerSeen(workerId: string): Fx<void>;
  journalCursors(workerId: string, journalId: string): Fx<{ threadId: string; lastSeq: bigint }[]>;
  listWorkers(online: ReadonlySet<string>, ownerUserId?: string): Fx<ui.Worker[]>;
}

interface WorkerListRow {
  id: string;
  name: string;
  os: string;
  version: string;
  capabilities: {
    hostname?: string;
    homeDirectory?: string;
    worktreesRoot?: string;
    projectSources?: boolean;
    workspaceCopy?: boolean;
    cliImport?: boolean;
    branchSwitch?: boolean;
  };
  last_seen_at: Date | null;
  revoked_at: Date | null;
  profile_names: Record<string, string>;
  config_version: bigint | null;
  applied_version: bigint | null;
  apply_report: JsonValue | null;
}

function listedWorker(r: WorkerListRow, online: ReadonlySet<string>) {
  const report = r.apply_report
    ? fromJson(ConfigAppliedSchema, r.apply_report, { ignoreUnknownFields: true })
    : undefined;

  // Names the user gave: the configuration knows them before the worker reports (older workers never do).
  for (const profile of report?.profiles ?? []) profile.displayName ||= r.profile_names[profile.id] ?? "";

  return create(ui.WorkerSchema, {
    id: r.id,
    name: r.name,
    online: !r.revoked_at && online.has(r.id),
    ...(r.revoked_at && { revokedAt: timestampFromDate(new Date(r.revoked_at)) }),
    hostname: r.capabilities?.hostname ?? "",
    os: r.os,
    version: r.version,
    providers: report?.providers ?? [],
    profiles: report?.profiles ?? [],
    homeDirectory: r.capabilities?.homeDirectory ?? "",
    worktrees: Boolean(r.capabilities?.worktreesRoot),
    worktreesRoot: r.capabilities?.worktreesRoot ?? "",
    projectSources: r.capabilities?.projectSources === true,
    workspaceCopy: r.capabilities?.workspaceCopy === true,
    cliImport: r.capabilities?.cliImport === true,
    branchSwitch: r.capabilities?.branchSwitch === true,
    configVersion: r.config_version ? BigInt(r.config_version) : 0n,
    appliedVersion: r.applied_version ? BigInt(r.applied_version) : 0n,
    configIssues: report?.issues ?? [],
    ...(r.last_seen_at && { lastSeenAt: timestampFromDate(new Date(r.last_seen_at)) }),
  });
}

export function workerStore(sql: SqlClient.SqlClient): WorkerStore {
  return {
    ensureUser: (email, displayName) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
                INSERT INTO users (id, email, display_name, role) VALUES (${Bun.randomUUIDv7()}::uuid, ${email}, ${displayName}, 'admin')
                ON CONFLICT (email) DO UPDATE SET display_name = users.display_name RETURNING id`;

        return (yield* one(rows, "user")).id;
      }),

    authenticateWorker: (credential) =>
      sql<{
        id: string;
      }>`SELECT id FROM workers WHERE credential_hash = ${hash(credential)} AND revoked_at IS NULL AND archived_at IS NULL`.pipe(
        Effect.map((rows) => rows[0]?.id),
      ),

    addWorker: ({ name, ownerUserId }) =>
      Effect.gen(function* () {
        const workerId = Bun.randomUUIDv7();
        const credential = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        yield* sql`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES (${workerId}::uuid, ${ownerUserId}::uuid, ${name}, ${hash(credential)})`;

        return { workerId, credential };
      }),

    workerConnected: (workerId, instanceId, hello) =>
      Effect.gen(function* () {
        const capabilities = JSON.stringify({
          providers: hello.providers.map((p) => ({
            provider: Provider[p.provider],
            available: p.available,
            version: p.version,
          })),
          // Where the worker keeps attachments (paths in the platform note); empty = it cannot take them.
          attachmentsRoot: hello.attachmentsRoot,
          scratchRoot: hello.scratchRoot,
          homeDirectory: hello.homeDirectory,
          // Git worktrees (docs/worktrees.md): empty = the worker cannot make them.
          worktreesRoot: hello.capabilities.includes("worktrees") ? hello.worktreesRoot : "",
          // New project directories and clones (InitRepository, CloneRepository).
          projectSources: hello.capabilities.includes("project_sources"),
          workspaceCopy: hello.capabilities.includes("workspace_copy_v1"),
          // Threads, settings and libraries of the device's CLIs (docs/import.md).
          cliImport: hello.capabilities.includes("cli_import_v1"),
          branchSwitch: hello.capabilities.includes("git_branch_switch_v1"),
          // The desktop app's own local-mode worker: it updates with the app (docs/updates.md).
          desktopBundled: hello.capabilities.includes("desktop_bundled"),
        });

        yield* sql`
                UPDATE workers SET os = ${hello.host?.os ?? ""}, arch = ${hello.host?.arch ?? ""}, version = ${hello.host?.workerVersion ?? ""},
                                   capabilities = capabilities || ${capabilities}::jsonb || ${JSON.stringify({ hostname: hello.host?.hostname ?? "" })}::jsonb,
                                   last_seen_at = now()
                 WHERE id = ${workerId}::uuid`;

        // A healthy WorkerLink on the commanded version also proves restart success when the result report was lost.
        if (hello.host?.workerVersion && workerLinkCompatible(hello.minWorkerLinkProtocol, hello.workerLinkProtocol)) {
          yield* sql`UPDATE workers SET capabilities = jsonb_set(capabilities, '{update}', capabilities->'update' || '{"state":"succeeded","reason":""}'::jsonb)
            WHERE id = ${workerId}::uuid AND capabilities->'update'->>'state' = 'restarting'
              AND capabilities->'updateCommand'->>'version' = ${hello.host?.workerVersion ?? ""}
              AND capabilities->'update'->>'targetVersion' = ${hello.host?.workerVersion ?? ""}`;
        }

        yield* sql`
                INSERT INTO worker_connections (worker_id, instance_id, epoch) VALUES (${workerId}::uuid, ${instanceId}, 1)
                ON CONFLICT (worker_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, epoch = worker_connections.epoch + 1, connected_at = now()`;
      }),

    workerSeen: (workerId) =>
      sql`UPDATE workers SET last_seen_at = now() WHERE id = ${workerId}::uuid`.pipe(Effect.asVoid),

    journalCursors: (workerId, journalId) =>
      sql<{ thread_id: string; acked_seq: bigint }>`
              SELECT thread_id, acked_seq FROM worker_journal_cursors WHERE worker_id = ${workerId}::uuid AND journal_id = ${journalId}`.pipe(
        Effect.map((rows) => rows.map((r) => ({ threadId: r.thread_id, lastSeq: BigInt(r.acked_seq) }))),
      ),

    listWorkers: (online, ownerUserId) =>
      Effect.gen(function* () {
        const rows = yield* sql<WorkerListRow>`
                SELECT w.id, w.name, w.os, w.version,
                       jsonb_build_object('hostname',w.capabilities->'hostname','homeDirectory',w.capabilities->'homeDirectory',
                         'worktreesRoot',w.capabilities->'worktreesRoot','projectSources',w.capabilities->'projectSources',
                         'workspaceCopy',w.capabilities->'workspaceCopy',
                         'cliImport',w.capabilities->'cliImport','branchSwitch',w.capabilities->'branchSwitch') AS capabilities, w.last_seen_at, w.revoked_at,
                       coalesce(c.profile_names,'{}'::jsonb) AS profile_names,
                       c.version AS config_version, c.applied_version, c.apply_report
                  FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
                 WHERE w.archived_at IS NULL
                   AND (${ownerUserId ?? null}::uuid IS NULL OR w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId ?? null}::uuid)
                 ORDER BY w.name`;

        return rows.map((r) => listedWorker(r, online));
      }),
  };
}

function hash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}
