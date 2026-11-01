import { createHash } from "node:crypto";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CommandSchema,
  ConfigAppliedSchema,
  InteractionKind,
  ItemSchema,
  PermissionMode,
  Provider,
  ThreadEventSchema,
  ThreadSpecSchema,
  UsageSchema,
  WorkerConfigSchema,
  ui,
  type Command,
  type ConfigApplied,
  type Hello,
  type InteractionRequest,
  type Item,
  type ThreadSpec,
  type WorkerConfig,
} from "@open-agents/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { isAbsolutePath, isWithinRoots, normalizePath, pathKey, pathStyle } from "./paths.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";

/**
 * Gateway data access (PostgreSQL). One service, grouped by concern; every query casts uuid
 * parameters explicitly because the driver sends strings as text.
 */

export class NotFound extends Error {
  override readonly name = "NotFound";
}
export class Invalid extends Error {
  override readonly name = "Invalid";
}

type Sql = SqlError.SqlError;
type Fx<A> = Effect.Effect<A, Sql | NotFound | Invalid>;

export interface ThreadRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  kind: "main" | "side";
  parent_thread_id: string | null;
  root_thread_id: string;
  depth: number;
  origin: string;
  interaction_route: "human" | "parent";
  agent_id: string | null;
  runtime: string;
  provider: string;
  provider_profile_id: string | null;
  worker_id: string | null;
  workspace_id: string | null;
  cwd: string | null;
  provider_thread_id: string | null;
  fork_source_thread_id: string | null;
  fork_after_turn_id: string | null;
  settings: { model?: string; permissionMode?: string; instructions?: string };
  status: string;
  status_detail: string | null;
  title: string;
  last_seq: bigint;
  created_at: Date;
  archived_at?: Date | null;
  pending_interactions?: bigint | number;
  last_activity_at?: Date | null;
  /** Joined: status of the open goal, running background tasks. */
  goal_status?: string | null;
  background_tasks?: bigint | number;
}

export interface TurnRow {
  id: string;
  thread_id: string;
  ordinal: number;
  status: string;
  trigger: string;
  /** text = what the model got; note + message = the same split for the UI (platform-queued turns). */
  input: { text?: string; note?: string; message?: string };
  error: string | null;
  provider_turn_ref: string | null;
  queued_at: Date;
  started_at?: Date | null;
  completed_at?: Date | null;
  usage?: JsonValue | null;
  hops?: number;
  schedule_id?: string | null;
  interaction_request_id?: string | null;
  goal_id?: string | null;
  /** Joined from turn_sources. */
  source_kind?: string | null;
  source_thread_id?: string | null;
  source_status?: string | null;
  question_kind?: string | null;
  question_tool?: string | null;
}

export interface OutboxRow {
  id: string;
  worker_id: string;
  thread_id: string | null;
  turn_id: string | null;
  kind: string;
  payload: Uint8Array;
}

export class GatewayStore extends Context.Service<
  GatewayStore,
  {
    // users
    ensureUser(email: string, displayName: string): Fx<string>;
    // workers
    authenticateWorker(credential: string): Fx<string | undefined>;
    addWorker(input: { name: string; ownerUserId: string }): Fx<{ workerId: string; credential: string }>;
    workerConnected(workerId: string, instanceId: string, hello: Hello): Fx<void>;
    workerSeen(workerId: string): Fx<void>;
    journalCursors(workerId: string, journalId: string): Fx<{ threadId: string; lastSeq: bigint }[]>;
    /**
     * Stores a new config version. Profile API keys are never stored inline: pass them as secret ids
     * (secretRefs: profile id -> secrets.id); they are resolved when the config is sent to the worker.
     */
    setWorkerConfig(
      workerId: string,
      config: MessageInitShape<typeof WorkerConfigSchema>,
      updatedBy: string,
      secretRefs?: Readonly<Record<string, string>>,
    ): Fx<bigint>;
    putSecret(input: { ownerUserId: string | null; name: string; plaintext: string; createdBy: string }): Fx<string>;
    workerConfig(workerId: string): Fx<WorkerConfig | undefined>;
    configApplied(workerId: string, report: ConfigApplied): Fx<void>;
    listWorkers(online: ReadonlySet<string>): Fx<ui.Worker[]>;
    // projects
    createProject(ownerUserId: string, name: string): Fx<ui.Project>;
    createWorkspace(input: { projectId: string; workerId: string; rootPath: string; label: string }): Fx<ui.Workspace>;
    listProjects(ownerUserId: string): Fx<ui.Project[]>;
    // threads and turns
    createThread(ownerUserId: string, request: ui.CreateThreadRequest): Fx<ThreadRow>;
    thread(threadId: string): Fx<ThreadRow>;
    /** Threads of a project, or of every project the user owns when projectId is empty. */
    listThreads(ownerUserId: string, projectId: string): Fx<ReadonlyArray<ThreadRow>>;
    threadSpec(row: ThreadRow): ThreadSpec;
    setThreadStatus(threadId: string, status: string, detail: string | null): Fx<void>;
    enqueueTurn(input: { threadId: string; text: string; userId: string; clientRequestId: string }): Fx<TurnRow>;
    /** Oldest queued user turn of an idle, ready thread with no StartTurn in the outbox yet. */
    nextTurn(threadId: string): Fx<TurnRow | undefined>;
    runningTurn(threadId: string): Fx<TurnRow | undefined>;
    turnsOf(threadId: string): Fx<ReadonlyArray<TurnRow>>;
    failTurn(turnId: string, error: string): Fx<void>;
    snapshot(threadId: string): Fx<{
      thread: ThreadRow;
      turns: (TurnRow & { inherited?: boolean })[];
      items: ui.TimelineItem[];
      interactions: ui.Interaction[];
      notices: ui.ThreadNotice[];
      lastSeq: bigint;
    }>;
    /** Current state of one of the thread's own items. */
    threadItem(threadId: string, itemId: string): Fx<Item | undefined>;
    // outbox
    enqueueCommand(input: { workerId: string; threadId?: string; turnId?: string; command: MessageInitShape<typeof CommandSchema>; ttlSeconds: number }): Fx<Command>;
    pendingCommands(workerId: string): Fx<Command[]>;
    commandDone(commandId: string, ok: boolean, result: JsonValue): Fx<void>;
    // interactions
    recordInteraction(request: InteractionRequest): Fx<ui.Interaction>;
    /** Answered by the user, or by the parent thread's agent (answer_interaction on the agent bus). */
    answerInteraction(requestId: string, by: { userId: string } | { threadId: string }, answer: ui.AnswerInteractionRequest): Fx<ui.Interaction>;
    pendingInteractions(threadId: string): Fx<ui.Interaction[]>;
    interactionAnswer(requestId: string): Fx<{ threadId: string; answer: ui.AnswerInteractionRequest } | undefined>;
  }
>()("open-agents/gateway/GatewayStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      GatewayStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const one = <A>(rows: ReadonlyArray<A>, what: string): Effect.Effect<A, NotFound> =>
          rows[0] === undefined ? Effect.fail(new NotFound(`${what} not found`)) : Effect.succeed(rows[0]);

        const threadSelect = (where: string) => `
          SELECT t.*, (SELECT count(*) FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending') AS pending_interactions,
                 greatest(t.created_at, (SELECT max(greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at)))
                                           FROM turns u WHERE u.thread_id = t.id)) AS last_activity_at,
                 (SELECT g.status FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled') LIMIT 1) AS goal_status,
                 (SELECT count(*) FROM thread_items b WHERE b.thread_id = t.id AND b.type = 'background_task' AND b.status = 'in_progress') AS background_tasks
            FROM threads t ${where}`;

        const store: GatewayStore["Service"] = {
          ensureUser: (email, displayName) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`
                INSERT INTO users (id, email, display_name, role) VALUES (${Bun.randomUUIDv7()}::uuid, ${email}, ${displayName}, 'admin')
                ON CONFLICT (email) DO UPDATE SET display_name = users.display_name RETURNING id`;
              return (yield* one(rows, "user")).id;
            }),

          authenticateWorker: (credential) =>
            sql<{ id: string }>`SELECT id FROM workers WHERE credential_hash = ${hash(credential)} AND revoked_at IS NULL AND archived_at IS NULL`.pipe(
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
              const capabilities = JSON.stringify({ providers: hello.providers.map((p) => ({ provider: Provider[p.provider], available: p.available, version: p.version })) });
              yield* sql`
                UPDATE workers SET os = ${hello.host?.os ?? ""}, arch = ${hello.host?.arch ?? ""}, version = ${hello.host?.workerVersion ?? ""},
                                   capabilities = capabilities || ${capabilities}::jsonb || ${JSON.stringify({ hostname: hello.host?.hostname ?? "" })}::jsonb,
                                   last_seen_at = now()
                 WHERE id = ${workerId}::uuid`;
              yield* sql`
                INSERT INTO worker_connections (worker_id, instance_id, epoch) VALUES (${workerId}::uuid, ${instanceId}, 1)
                ON CONFLICT (worker_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, epoch = worker_connections.epoch + 1, connected_at = now()`;
            }),

          workerSeen: (workerId) => sql`UPDATE workers SET last_seen_at = now() WHERE id = ${workerId}::uuid`.pipe(Effect.asVoid),

          journalCursors: (workerId, journalId) =>
            sql<{ thread_id: string; acked_seq: bigint }>`
              SELECT thread_id, acked_seq FROM worker_journal_cursors WHERE worker_id = ${workerId}::uuid AND journal_id = ${journalId}`.pipe(
              Effect.map((rows) => rows.map((r) => ({ threadId: r.thread_id, lastSeq: BigInt(r.acked_seq) }))),
            ),

          setWorkerConfig: (workerId, config, updatedBy, secretRefs = {}) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{ version: bigint }>`SELECT version FROM worker_configs WHERE worker_id = ${workerId}::uuid FOR UPDATE`;
                const version = (rows[0] ? BigInt(rows[0].version) : 0n) + 1n;
                const document = toJson(WorkerConfigSchema, create(WorkerConfigSchema, { ...config, version })) as {
                  profiles?: { id?: string; apiKey?: unknown }[];
                };
                for (const profile of document.profiles ?? []) {
                  if (profile.apiKey) return yield* Effect.fail(new Invalid(`profile ${profile.id}: pass API keys as secret references`));
                  const ref = profile.id ? secretRefs[profile.id] : undefined;
                  if (ref) profile.apiKey = { secretRef: ref };
                }
                yield* sql`
                  INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES (${workerId}::uuid, ${version}, ${JSON.stringify(document)}::jsonb, ${updatedBy}::uuid)
                  ON CONFLICT (worker_id) DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`;
                yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${workerId}::uuid`;
                for (const secretId of Object.values(secretRefs)) {
                  yield* sql`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES (${workerId}::uuid, ${secretId}::uuid) ON CONFLICT DO NOTHING`;
                }
                return version;
              }),
            ),

          putSecret: ({ ownerUserId, name, plaintext, createdBy }) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`
                INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${ownerUserId}::uuid, ${name}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${createdBy}::uuid)
                ON CONFLICT (owner_user_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, rotated_at = now()
                RETURNING id`;
              return (yield* one(rows, "secret")).id;
            }),

          workerConfig: (workerId) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ config: { profiles?: { apiKey?: unknown }[] } & Record<string, unknown> }>`
                SELECT config FROM worker_configs WHERE worker_id = ${workerId}::uuid`;
              const config = rows[0]?.config;
              if (!config) return undefined;
              // Resolve {"secretRef": id} placeholders right before sending; plaintext never touches the table.
              for (const profile of config.profiles ?? []) {
                const ref = (profile.apiKey as { secretRef?: string } | undefined)?.secretRef;
                if (!ref) continue;
                const secret = yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets WHERE id = ${ref}::uuid`;
                profile.apiKey = secret[0] ? decryptSecret(secretsKey, secret[0].ciphertext) : "";
              }
              return fromJson(WorkerConfigSchema, config as JsonValue);
            }),

          configApplied: (workerId, report) =>
            sql`
              UPDATE worker_configs SET applied_version = ${report.version}, applied_ok = ${report.applied}, applied_at = now(),
                                        apply_report = ${JSON.stringify(toJson(ConfigAppliedSchema, report))}::jsonb
               WHERE worker_id = ${workerId}::uuid AND version >= ${report.version}`.pipe(Effect.asVoid),

          listWorkers: (online) =>
            Effect.gen(function* () {
              const rows = yield* sql<{
                id: string; name: string; os: string; version: string; capabilities: { hostname?: string }; last_seen_at: Date | null;
                config: JsonValue | null; config_version: bigint | null; applied_version: bigint | null; apply_report: JsonValue | null;
              }>`
                SELECT w.id, w.name, w.os, w.version, w.capabilities, w.last_seen_at,
                       c.config, c.version AS config_version, c.applied_version, c.apply_report
                  FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
                 WHERE w.archived_at IS NULL AND w.revoked_at IS NULL ORDER BY w.name`;
              return rows.map((r) => {
                const report = r.apply_report ? fromJson(ConfigAppliedSchema, r.apply_report) : undefined;
                const roots = (r.config as { allowedRoots?: string[] } | null)?.allowedRoots ?? [];
                return create(ui.WorkerSchema, {
                  id: r.id,
                  name: r.name,
                  online: online.has(r.id),
                  hostname: r.capabilities?.hostname ?? "",
                  os: r.os,
                  version: r.version,
                  providers: report?.providers ?? [],
                  profiles: report?.profiles ?? [],
                  allowedRoots: roots,
                  configVersion: r.config_version ? BigInt(r.config_version) : 0n,
                  appliedVersion: r.applied_version ? BigInt(r.applied_version) : 0n,
                  configIssues: report?.issues ?? [],
                  ...(r.last_seen_at && { lastSeenAt: timestampFromDate(new Date(r.last_seen_at)) }),
                });
              });
            }),

          createProject: (ownerUserId, name) =>
            Effect.gen(function* () {
              const trimmed = name.trim();
              if (!trimmed) return yield* Effect.fail(new Invalid("project name is required"));
              const id = Bun.randomUUIDv7();
              const slug = `${slugify(trimmed)}-${id.slice(-6)}`;
              yield* sql`INSERT INTO projects (id, owner_user_id, name, slug) VALUES (${id}::uuid, ${ownerUserId}::uuid, ${trimmed}, ${slug})`;
              return create(ui.ProjectSchema, { id, name: trimmed, slug, workspaces: [] });
            }),

          createWorkspace: ({ projectId, workerId, rootPath, label }) =>
            Effect.gen(function* () {
              // A project spans workers (Linux, macOS, Windows): the path follows the worker's rules.
              const workers = yield* sql<{ os: string; config: { allowedRoots?: string[] } | null }>`
                SELECT w.os, c.config FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
                 WHERE w.id = ${workerId}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL`;
              const worker = workers[0];
              if (!worker) return yield* Effect.fail(new NotFound("worker not found"));
              // Before the worker's first connection its OS is unknown: its configured roots tell the style.
              const style = pathStyle(worker.os, worker.config?.allowedRoots?.[0] ?? rootPath);
              if (!isAbsolutePath(rootPath, style)) return yield* Effect.fail(new Invalid("root path must be absolute"));
              const root = normalizePath(rootPath, style);
              // Lexical check against the worker's configured roots, so a workspace never points outside them.
              // The worker remains the authority: it checks real paths (symlinks) when a thread starts.
              if (!isWithinRoots(root, worker.config?.allowedRoots ?? [], style, worker.os)) {
                return yield* Effect.fail(new Invalid(`${root} is outside the worker's allowed directories`));
              }
              const existing = yield* sql<{ root_path: string }>`
                SELECT root_path FROM project_workspaces
                 WHERE project_id = ${projectId}::uuid AND worker_id = ${workerId}::uuid AND archived_at IS NULL`;
              const key = pathKey(root, style, worker.os);
              if (existing.some((w) => pathKey(w.root_path, style, worker.os) === key)) {
                return yield* Effect.fail(new Invalid(`${root} is already a workspace of this project on this worker`));
              }
              const id = Bun.randomUUIDv7();
              yield* sql`
                INSERT INTO project_workspaces (id, project_id, worker_id, root_path, label)
                VALUES (${id}::uuid, ${projectId}::uuid, ${workerId}::uuid, ${root}, ${label})`;
              return create(ui.WorkspaceSchema, { id, projectId, workerId, rootPath: root, label });
            }),

          listProjects: (ownerUserId) =>
            Effect.gen(function* () {
              const projects = yield* sql<{ id: string; name: string; slug: string }>`
                SELECT id, name, slug FROM projects WHERE owner_user_id = ${ownerUserId}::uuid AND archived_at IS NULL ORDER BY created_at`;
              const workspaces = yield* sql<{ id: string; project_id: string; worker_id: string; root_path: string; label: string }>`
                SELECT w.id, w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w
                  JOIN projects p ON p.id = w.project_id
                 WHERE p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL ORDER BY w.created_at`;
              return projects.map((p) =>
                create(ui.ProjectSchema, {
                  ...p,
                  workspaces: workspaces
                    .filter((w) => w.project_id === p.id)
                    .map((w) => ({ id: w.id, projectId: w.project_id, workerId: w.worker_id, rootPath: w.root_path, label: w.label })),
                }),
              );
            }),

          createThread: (ownerUserId, request) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const workspace = yield* one(
                  yield* sql<{ id: string; project_id: string; worker_id: string; root_path: string; os: string }>`
                    SELECT pw.id, pw.project_id, pw.worker_id, pw.root_path, w.os
                      FROM project_workspaces pw JOIN workers w ON w.id = pw.worker_id
                     WHERE pw.id = ${request.workspaceId}::uuid AND pw.project_id = ${request.projectId}::uuid AND pw.archived_at IS NULL`,
                  "workspace",
                );
                const provider = request.provider === Provider.CLAUDE ? "claude" : "codex";
                const id = Bun.randomUUIDv7();
                const parent = request.parentThreadId ? yield* store.thread(request.parentThreadId) : undefined;
                if (parent && parent.workspace_id !== workspace.id) {
                  return yield* Effect.fail(new Invalid("a side thread runs in its parent's workspace"));
                }
                if (parent && request.fork && parent.provider !== provider) {
                  return yield* Effect.fail(new Invalid(`a fork keeps its parent's provider (${parent.provider})`));
                }
                // A thread may start below the workspace root, never outside it (paths follow the worker's OS).
                const style = pathStyle(workspace.os, workspace.root_path);
                const requested = request.cwd ? normalizePath(request.cwd, style) : undefined;
                if (requested && (!isAbsolutePath(request.cwd, style) || !isWithinRoots(requested, [workspace.root_path], style, workspace.os))) {
                  return yield* Effect.fail(new Invalid(`${request.cwd} is outside the workspace ${workspace.root_path}`));
                }
                const cwd = parent?.cwd ?? requested ?? workspace.root_path;
                const settings = JSON.stringify({
                  model: request.model,
                  permissionMode: PermissionMode[request.permissionMode] ?? "ASK",
                  instructions: request.instructions,
                });
                yield* sql`
                  INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, runtime, provider,
                                       provider_profile_id, worker_id, workspace_id, cwd, fork_source_thread_id, settings, status, title)
                  VALUES (${id}::uuid, ${workspace.project_id}::uuid, ${ownerUserId}::uuid, ${parent ? "side" : "main"},
                          ${parent?.id ?? null}::uuid, ${parent?.root_thread_id ?? id}::uuid, ${parent ? parent.depth + 1 : 0}, 'worker', ${provider},
                          ${request.providerProfileId && request.providerProfileId !== "native" ? request.providerProfileId : null}, ${workspace.worker_id}::uuid, ${workspace.id}::uuid, ${cwd},
                          ${parent && request.fork ? parent.id : null}::uuid, ${settings}::jsonb, 'creating', ${request.title.trim() || "New thread"})`;
                if (request.initialMessage.trim()) {
                  yield* sql`
                    INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                    VALUES (${Bun.randomUUIDv7()}::uuid, ${id}::uuid, 1, 'user', ${ownerUserId}::uuid, ${request.clientRequestId || null},
                            ${JSON.stringify({ text: request.initialMessage })}::jsonb)`;
                }
                return yield* store.thread(id);
              }),
            ),

          thread: (threadId) =>
            sql.unsafe<ThreadRow>(threadSelect("WHERE t.id = $1::uuid"), [threadId]).pipe(Effect.flatMap((rows) => one(rows, "thread"))),

          listThreads: (ownerUserId, projectId) =>
            projectId
              ? sql.unsafe<ThreadRow>(threadSelect("WHERE t.project_id = $1::uuid AND t.archived_at IS NULL ORDER BY t.created_at"), [projectId])
              : sql.unsafe<ThreadRow>(
                  threadSelect(
                    "WHERE t.owner_user_id = $1::uuid AND t.archived_at IS NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL) ORDER BY t.created_at",
                  ),
                  [ownerUserId],
                ),

          threadSpec: (row) =>
            create(ThreadSpecSchema, {
              threadId: row.id,
              provider: row.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
              providerProfileId: row.provider_profile_id ?? "",
              cwd: row.cwd ?? "",
              model: row.settings.model ?? "",
              instructions: row.settings.instructions ?? "",
              permissionMode: PermissionMode[(row.settings.permissionMode ?? "ASK") as keyof typeof PermissionMode] ?? PermissionMode.ASK,
              // Agent bus tools for every worker thread: Codex dynamicTools, Claude MCP (docs/agent-bus.md).
              enableAgentBus: row.runtime === "worker",
              providerThreadId: row.provider_thread_id ?? "",
              depth: row.depth,
            }),

          setThreadStatus: (threadId, status, detail) =>
            sql`UPDATE threads SET status = ${status}, status_detail = ${detail} WHERE id = ${threadId}::uuid`.pipe(Effect.asVoid),

          enqueueTurn: ({ threadId, text, userId, clientRequestId }) =>
            Effect.gen(function* () {
              if (!text.trim()) return yield* Effect.fail(new Invalid("message is empty"));
              const rows = yield* sql<TurnRow>`
                INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                SELECT ${Bun.randomUUIDv7()}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'user', ${userId}::uuid,
                       ${clientRequestId || null}, ${JSON.stringify({ text })}::jsonb
                  FROM turns WHERE thread_id = ${threadId}::uuid
                ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
                RETURNING *`;
              if (rows[0]) return rows[0];
              return yield* one(yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`, "turn");
            }),

          nextTurn: (threadId) =>
            sql<TurnRow>`
              SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
               WHERE u.thread_id = ${threadId}::uuid AND u.status = 'queued' AND t.provider_thread_id IS NOT NULL
                 AND t.status IN ('idle', 'interrupted', 'failed')
                 AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = u.thread_id AND r.status = 'running')
                 AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))
               ORDER BY u.ordinal LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

          runningTurn: (threadId) =>
            sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND status = 'running' LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

          turnsOf: (threadId) => sql<TurnRow>`
            SELECT u.*, s.source_kind, s.source_thread_id, s.source_status, s.question_kind, s.question_tool FROM turns u LEFT JOIN turn_sources s ON s.turn_id = u.id
             WHERE u.thread_id = ${threadId}::uuid ORDER BY u.ordinal`,

          failTurn: (turnId, error) =>
            sql`UPDATE turns SET status = 'failed', error = ${error}, completed_at = now() WHERE id = ${turnId}::uuid AND status IN ('queued', 'running')`.pipe(
              Effect.asVoid,
            ),

          snapshot: (threadId) =>
            Effect.gen(function* () {
              const thread = yield* store.thread(threadId);
              // A fork shows the history it inherits (thread_items_view / thread_fork_chain), marked as inherited.
              const inheritedTurns = yield* sql<TurnRow>`
                SELECT u.*, s.source_kind, s.source_thread_id, s.source_status, s.question_kind, s.question_tool FROM thread_fork_chain(${threadId}::uuid) c
                  JOIN turns u ON u.thread_id = c.thread_id LEFT JOIN turn_sources s ON s.turn_id = u.id
                 WHERE c.level > 0 AND u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)
                 ORDER BY c.level DESC, u.ordinal`;
              const turns = yield* store.turnsOf(threadId);
              const itemRows = yield* sql<{ thread_id: string; content: JsonValue; turn_id: string | null; first_seq: bigint; last_seq: bigint; inherited: boolean }>`
                SELECT thread_id, content, turn_id, first_seq, last_seq, inherited FROM thread_items_view(${threadId}::uuid)`;
              const items = itemRows.map((r) =>
                create(ui.TimelineItemSchema, {
                  item: fromJson(ItemSchema, r.content),
                  turnId: r.turn_id ?? "",
                  firstSeq: BigInt(r.first_seq),
                  lastSeq: BigInt(r.last_seq),
                  inherited: r.inherited,
                  fromThreadId: r.inherited ? r.thread_id : "",
                }),
              );
              const noticeRows = yield* sql<{ seq: bigint; turn_id: string | null; payload: JsonValue; occurred_at: Date }>`
                SELECT seq, turn_id, payload, occurred_at FROM (
                  SELECT seq, turn_id, payload, occurred_at FROM thread_events
                   WHERE thread_id = ${threadId}::uuid AND kind = 'notice' ORDER BY seq DESC LIMIT 200) n
                 ORDER BY seq`;
              const notices = noticeRows.flatMap((r) => {
                const event = fromJson(ThreadEventSchema, r.payload);
                return event.body.case === "notice"
                  ? [create(ui.ThreadNoticeSchema, { seq: BigInt(r.seq), turnId: r.turn_id ?? "", notice: event.body.value, occurredAt: timestampFromDate(new Date(r.occurred_at)) })]
                  : [];
              });
              const interactions = yield* store.pendingInteractions(threadId);
              return {
                thread,
                turns: [...inheritedTurns.map((t) => ({ ...t, inherited: true })), ...turns],
                items,
                interactions,
                notices,
                lastSeq: BigInt(thread.last_seq),
              };
            }),

          threadItem: (threadId, itemId) =>
            sql<{ content: JsonValue }>`SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId}`.pipe(
              Effect.map((rows) => (rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined)),
            ),

          enqueueCommand: ({ workerId, threadId, turnId, command, ttlSeconds }) =>
            Effect.gen(function* () {
              const message = create(CommandSchema, { ...command, commandId: command.commandId || Bun.randomUUIDv7() } as MessageInitShape<typeof CommandSchema>);
              yield* sql`
                INSERT INTO worker_commands (id, worker_id, thread_id, turn_id, kind, payload, expires_at)
                VALUES (${message.commandId}::uuid, ${workerId}::uuid, ${threadId ?? null}::uuid, ${turnId ?? null}::uuid,
                        ${message.kind.case ?? "unknown"}, ${toBinary(CommandSchema, message)}, now() + make_interval(secs => ${ttlSeconds}))`;
              return message;
            }),

          pendingCommands: (workerId) =>
            sql<OutboxRow>`
              SELECT id, worker_id, thread_id, turn_id, kind, payload FROM worker_commands
               WHERE worker_id = ${workerId}::uuid AND status IN ('pending', 'delivered') AND expires_at > now() ORDER BY created_at`.pipe(
              Effect.map((rows) => rows.map((r) => fromBinary(CommandSchema, r.payload))),
            ),

          commandDone: (commandId, ok, result) =>
            sql`
              UPDATE worker_commands SET status = ${ok ? "completed" : "failed"}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
               WHERE id = ${commandId}::uuid`.pipe(Effect.asVoid),

          recordInteraction: (request) =>
            Effect.gen(function* () {
              const thread = yield* store.thread(request.threadId);
              const rows = yield* sql<InteractionRow>`
                INSERT INTO interaction_requests (id, thread_id, turn_id, item_id, kind, tool_name, request, routed_to)
                VALUES (${request.requestId}::uuid, ${request.threadId}::uuid,
                        (SELECT id FROM turns WHERE id = ${request.turnId || null}::uuid AND thread_id = ${request.threadId}::uuid),
                        ${request.itemId || null}, ${interactionKind(request.kind)}, ${request.toolName}, ${request.requestJson || "{}"}::jsonb,
                        ${thread.interaction_route})
                ON CONFLICT (id) DO UPDATE SET request = interaction_requests.request
                RETURNING *`;
              return toInteraction(yield* one(rows, "interaction"));
            }),

          answerInteraction: (requestId, by, answer) =>
            sql.withTransaction(Effect.gen(function* () {
              const current = yield* one(yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid`, "interaction");
              if (current.status !== "pending") return yield* Effect.fail(new Invalid(`interaction is already ${current.status}`));
              const status = answer.cancelled
                ? "cancelled"
                : current.kind === "permission"
                  ? answer.allow
                    ? "allowed"
                    : "declined"
                  : "answered";
              // Cancellation has no author (interaction_requests_answered_by).
              const userId = "userId" in by && !answer.cancelled ? by.userId : null;
              const threadId = "threadId" in by && !answer.cancelled ? by.threadId : null;
              const rows = yield* sql<InteractionRow>`
                UPDATE interaction_requests SET status = ${status}, answered_by = ${userId}::uuid, answered_by_thread_id = ${threadId}::uuid,
                       answered_at = now(),
                       response = ${JSON.stringify({ allow: answer.allow, allowForSession: answer.allowForSession, message: answer.message, answerJson: answer.answerJson, cancelled: answer.cancelled })}::jsonb
                 WHERE id = ${requestId}::uuid RETURNING *`;
              // The parent agent no longer needs the turn that would have asked it.
              yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE interaction_request_id = ${requestId}::uuid AND status = 'queued'`;
              return toInteraction(yield* one(rows, "interaction"));
            })),

          pendingInteractions: (threadId) =>
            sql<InteractionRow>`SELECT * FROM interaction_requests WHERE thread_id = ${threadId}::uuid AND status = 'pending' ORDER BY created_at`.pipe(
              Effect.map((rows) => rows.map(toInteraction)),
            ),

          interactionAnswer: (requestId) =>
            sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid AND status <> 'pending'`.pipe(
              Effect.map((rows) => {
                const row = rows[0];
                if (!row?.response) return undefined;
                return { threadId: row.thread_id, answer: create(ui.AnswerInteractionRequestSchema, { requestId, ...(row.response as object) }) };
              }),
            ),
        };
        return GatewayStore.of(store);
      }),
    );
}

interface InteractionRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  kind: string;
  tool_name: string;
  request: JsonValue;
  status: string;
  routed_to: string;
  response: JsonValue | null;
  created_at: Date;
}

function toInteraction(row: InteractionRow): ui.Interaction {
  return create(ui.InteractionSchema, {
    requestId: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id ?? "",
    itemId: row.item_id ?? "",
    kind: row.kind === "permission" ? InteractionKind.PERMISSION : row.kind === "question" ? InteractionKind.QUESTION : InteractionKind.ELICITATION,
    toolName: row.tool_name,
    requestJson: JSON.stringify(row.request),
    status: row.status,
    routedTo: row.routed_to,
    createdAt: timestampFromDate(new Date(row.created_at)),
  });
}

function interactionKind(kind: InteractionKind): string {
  return kind === InteractionKind.QUESTION ? "question" : kind === InteractionKind.ELICITATION ? "elicitation" : "permission";
}

export function toUiThread(row: ThreadRow): ui.Thread {
  return create(ui.ThreadSchema, {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind === "side" ? ui.ThreadKind.SIDE : ui.ThreadKind.MAIN,
    parentThreadId: row.parent_thread_id ?? "",
    title: row.title,
    provider: row.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
    providerProfileId: row.provider_profile_id ?? "",
    model: row.settings.model ?? "",
    permissionMode: PermissionMode[(row.settings.permissionMode ?? "ASK") as keyof typeof PermissionMode] ?? PermissionMode.ASK,
    workerId: row.worker_id ?? "",
    workspaceId: row.workspace_id ?? "",
    cwd: row.cwd ?? "",
    status: row.status,
    agentId: row.agent_id ?? "",
    spawnedByAgent: row.origin === "agent",
    statusDetail: row.status_detail ?? "",
    lastSeq: BigInt(row.last_seq),
    createdAt: timestampFromDate(new Date(row.created_at)),
    pendingInteractions: Number(row.pending_interactions ?? 0),
    forkSourceThreadId: row.fork_source_thread_id ?? "",
    rootThreadId: row.root_thread_id,
    interactionRoute: row.interaction_route,
    ...(row.last_activity_at && { lastActivityAt: timestampFromDate(new Date(row.last_activity_at)) }),
    goalStatus: row.goal_status ?? "",
    backgroundTasks: Number(row.background_tasks ?? 0),
  });
}

export function toUiTurn(row: TurnRow & { inherited?: boolean }): ui.Turn {
  return create(ui.TurnSchema, {
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    trigger: row.trigger,
    inputText: row.input?.text ?? "",
    error: row.error ?? "",
    queuedAt: timestampFromDate(new Date(row.queued_at)),
    ...(row.started_at && { startedAt: timestampFromDate(new Date(row.started_at)) }),
    ...(row.completed_at && { completedAt: timestampFromDate(new Date(row.completed_at)) }),
    ...(row.usage && { usage: fromJson(UsageSchema, row.usage) }),
    hops: row.hops ?? 0,
    inherited: row.inherited ?? false,
    fromThreadId: row.inherited ? row.thread_id : "",
    messageText: row.input?.message ?? row.input?.text ?? "",
    platformNote: row.input?.note ?? "",
    sourceStatus: row.source_status ?? "",
    questionKind: row.question_kind ?? "",
    questionTool: row.question_tool ?? "",
    sourceKind: row.source_kind ?? "",
    sourceThreadId: row.source_thread_id ?? "",
    scheduleId: row.schedule_id ?? "",
    interactionRequestId: row.interaction_request_id ?? "",
    goalId: row.goal_id ?? "",
  });
}

function hash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "project"
  );
}

