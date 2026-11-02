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
import { toUiAttachment, type StoredAttachment } from "./attachments.ts";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  settings: { model?: string; effort?: string; permissionMode?: string; instructions?: string };
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
  /** Joined for side threads: the start of the last agent message (a subagent's result). */
  last_message?: string | null;
  unseen_result?: string | null;
}

/** Characters of a side thread's last message in ui.Thread (the subagent card in the parent's timeline). */
const LAST_MESSAGE_PREVIEW = 600;

export interface TurnRow {
  id: string;
  thread_id: string;
  ordinal: number;
  status: string;
  trigger: string;
  /**
   * text = what the model got; note + message = the same split for the UI (platform-queued turns, a message with
   * attachments: the note lists them); attachments = the files of the message, with their paths on the worker.
   */
  input: { text?: string; note?: string; message?: string; attachments?: StoredAttachment[] };
  /** The message's override while queued; the values sent to the worker once started ('' = default). */
  model?: string;
  effort?: string;
  /** Same as model: the override ('' = the thread's default), then the mode sent (PermissionMode enum name). */
  permission_mode?: string;
  error: string | null;
  /** failed: platform | harness; interrupted: user | system (docs/durability.md, "Stany tury i wątku"). */
  error_source?: string | null;
  error_code?: string | null;
  interrupt_reason?: string | null;
  interrupt_source?: string | null;
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
    /** Another directory (same worker) or label; unset = unchanged. Threads keep their own directory. */
    updateWorkspace(ownerUserId: string, input: { workspaceId: string; rootPath?: string | undefined; label?: string | undefined }): Fx<ui.Workspace>;
    /** Takes the project off the workspace's worker (archived): no new threads there, existing ones go on. */
    removeWorkspace(ownerUserId: string, workspaceId: string): Fx<ui.Workspace>;
    listProjects(ownerUserId: string): Fx<ui.Project[]>;
    // threads and turns
    createThread(ownerUserId: string, request: ui.CreateThreadRequest): Fx<ThreadRow>;
    thread(threadId: string): Fx<ThreadRow>;
    /** The owner saw the thread up to `upToSeq` (capped at its last event; the marker only grows). False when nothing changed. */
    markThreadSeen(ownerUserId: string, threadId: string, upToSeq: bigint): Fx<boolean>;
    /** Threads of a project, or of every project the user owns when projectId is empty. */
    listThreads(ownerUserId: string, projectId: string): Fx<ReadonlyArray<ThreadRow>>;
    threadSpec(row: ThreadRow): ThreadSpec;
    setThreadStatus(threadId: string, status: string, detail: string | null): Fx<void>;
    /**
     * A user's message as the next turn. With attachments: `input` is the prepared input (note + message) and the
     * attachments are bound to the turn in the same transaction (each only once).
     */
    enqueueTurn(input: {
      threadId: string;
      text: string;
      userId: string;
      clientRequestId: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
      input?: TurnRow["input"];
    }): Fx<TurnRow>;
    /** A user turn with this client request id, if any (SendMessage idempotency across queue and steer). */
    turnByClientRequest(threadId: string, clientRequestId: string): Fx<TurnRow | undefined>;
    /** The thread's default model, effort and permission mode (unset = unchanged). */
    updateThreadSettings(threadId: string, settings: { model?: string; effort?: string; permissionMode?: string }): Fx<ThreadRow>;
    /** Records the model, effort and permission mode a turn is started with. */
    setTurnSettings(turnId: string, settings: { model: string; effort: string; permissionMode: string }): Fx<void>;
    /** Oldest queued user turn of an idle, ready thread with no StartTurn in the outbox yet. */
    nextTurn(threadId: string): Fx<TurnRow | undefined>;
    runningTurn(threadId: string): Fx<TurnRow | undefined>;
    turnsOf(threadId: string): Fx<ReadonlyArray<TurnRow>>;
    /** A queued or running turn fails here (e.g. it could not start): the error, where it came from, its code. */
    failTurn(turnId: string, error: string, source: "platform" | "harness", code?: string): Fx<void>;
    /** Pending interactions of the thread's finished turns expire (nothing can answer them any more). */
    expireEndedInteractions(threadId: string): Fx<ui.Interaction[]>;
    /**
     * Ends running worker turns that no longer run on their worker (docs/durability.md, 3.4): the given turns,
     * or every running turn of the worker's threads except `keep` (its Hello.running_turns). The turn ends as
     * interrupted by the system with the reason and the thread is idle again; its pending interactions expire and
     * its steers that did not join it are dropped (pump queues them). A late turn_finished from the worker (e.g. the
     * outcome its harness transcript records) still sets the real outcome.
     */
    endLostTurns(input: { workerId: string; reason: string } & ({ turnIds: readonly string[] } | { keep: readonly { threadId: string; turnId: string }[] })): Fx<{
      turns: { threadId: string; turnId: string }[];
      interactions: ui.Interaction[];
    }>;
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

        /**
         * A workspace directory on a worker, normalized: absolute, inside the worker's allowed roots and not
         * already a workspace of the project there (`except`: the workspace being moved).
         */
        const workspaceRoot = (input: { projectId: string; workerId: string; rootPath: string; except?: string }) =>
          Effect.gen(function* () {
            const { projectId, workerId, rootPath } = input;
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
            const existing = yield* sql<{ id: string; root_path: string }>`
              SELECT id, root_path FROM project_workspaces
               WHERE project_id = ${projectId}::uuid AND worker_id = ${workerId}::uuid AND archived_at IS NULL`;
            const key = pathKey(root, style, worker.os);
            if (existing.some((w) => w.id !== input.except && pathKey(w.root_path, style, worker.os) === key)) {
              return yield* Effect.fail(new Invalid(`${root} is already a workspace of this project on this worker`));
            }
            return root;
          });

        /** An active workspace of a project the user owns. */
        const ownedWorkspace = (ownerUserId: string, workspaceId: string) =>
          Effect.gen(function* () {
            return yield* one(
              yield* sql<{ project_id: string; worker_id: string; root_path: string; label: string }>`
                SELECT w.project_id, w.worker_id, w.root_path, w.label FROM project_workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ${workspaceId}::uuid AND p.owner_user_id = ${ownerUserId}::uuid AND w.archived_at IS NULL AND p.archived_at IS NULL`,
              "workspace",
            );
          });

        const threadSelect = (where: string) => `
          SELECT t.*, (SELECT count(*) FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending') AS pending_interactions,
                 greatest(t.created_at, (SELECT max(greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at)))
                                           FROM turns u WHERE u.thread_id = t.id)) AS last_activity_at,
                 (SELECT g.status FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled') LIMIT 1) AS goal_status,
                 (SELECT count(*) FROM thread_items b WHERE b.thread_id = t.id AND b.type = 'background_task' AND b.status = 'in_progress') AS background_tasks,
                 (SELECT u.status FROM turns u
                   WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                     AND u.last_seq > coalesce((SELECT r.seen_seq FROM thread_reads r WHERE r.user_id = t.owner_user_id AND r.thread_id = t.id), 0)
                   ORDER BY u.last_seq DESC LIMIT 1) AS unseen_result,
                 CASE WHEN t.kind = 'side' THEN
                   (SELECT left(m.content->'agentMessage'->>'text', ${LAST_MESSAGE_PREVIEW}) FROM thread_items m
                     WHERE m.thread_id = t.id AND m.type = 'agent_message' ORDER BY m.first_seq DESC LIMIT 1) END AS last_message
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
              const capabilities = JSON.stringify({
                providers: hello.providers.map((p) => ({ provider: Provider[p.provider], available: p.available, version: p.version })),
                // Where the worker keeps attachments (paths in the platform note); empty = it cannot take them.
                attachmentsRoot: hello.attachmentsRoot,
              });
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
                  profiles?: { id?: string; apiKey?: unknown; env?: { secret?: boolean; value?: unknown }[] }[];
                };
                for (const profile of document.profiles ?? []) {
                  if (profile.apiKey) return yield* Effect.fail(new Invalid(`profile ${profile.id}: pass API keys as secret references`));
                  // Secret variables only through the profile settings (ProfileStore), which stores them encrypted.
                  if (profile.env?.some((v) => v.secret && v.value)) return yield* Effect.fail(new Invalid(`profile ${profile.id}: secret variables go through the profile settings`));
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
              const rows = yield* sql<{ config: { profiles?: { apiKey?: unknown; env?: { value?: unknown }[] }[] } & Record<string, unknown> }>`
                SELECT config FROM worker_configs WHERE worker_id = ${workerId}::uuid`;
              const config = rows[0]?.config;
              if (!config) return undefined;
              // Resolve {"secretRef": id} placeholders right before sending; plaintext never touches the table.
              const resolve = (value: unknown) =>
                Effect.gen(function* () {
                  const ref = (value as { secretRef?: string } | undefined)?.secretRef;
                  if (!ref) return value;
                  const secret = yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets WHERE id = ${ref}::uuid`;
                  return secret[0] ? decryptSecret(secretsKey, secret[0].ciphertext) : "";
                });
              for (const profile of config.profiles ?? []) {
                if (profile.apiKey) profile.apiKey = yield* resolve(profile.apiKey);
                for (const variable of profile.env ?? []) variable.value = yield* resolve(variable.value);
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
                const report = r.apply_report ? fromJson(ConfigAppliedSchema, r.apply_report, { ignoreUnknownFields: true }) : undefined;
                const config = r.config as { allowedRoots?: string[]; profiles?: { id?: string; displayName?: string }[] } | null;
                const roots = config?.allowedRoots ?? [];
                // Names the user gave: the configuration knows them before the worker reports (older workers never do).
                for (const profile of report?.profiles ?? []) {
                  profile.displayName ||= config?.profiles?.find((p) => p.id === profile.id)?.displayName ?? "";
                }
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
              const root = yield* workspaceRoot({ projectId, workerId, rootPath });
              const id = Bun.randomUUIDv7();
              yield* sql`
                INSERT INTO project_workspaces (id, project_id, worker_id, root_path, label)
                VALUES (${id}::uuid, ${projectId}::uuid, ${workerId}::uuid, ${root}, ${label})`;
              return create(ui.WorkspaceSchema, { id, projectId, workerId, rootPath: root, label });
            }),

          updateWorkspace: (ownerUserId, { workspaceId, rootPath, label }) =>
            Effect.gen(function* () {
              const current = yield* ownedWorkspace(ownerUserId, workspaceId);
              const root =
                rootPath === undefined
                  ? current.root_path
                  : yield* workspaceRoot({ projectId: current.project_id, workerId: current.worker_id, rootPath, except: workspaceId });
              const nextLabel = label ?? current.label;
              yield* sql`UPDATE project_workspaces SET root_path = ${root}, label = ${nextLabel} WHERE id = ${workspaceId}::uuid`;
              return create(ui.WorkspaceSchema, { id: workspaceId, projectId: current.project_id, workerId: current.worker_id, rootPath: root, label: nextLabel });
            }),

          removeWorkspace: (ownerUserId, workspaceId) =>
            Effect.gen(function* () {
              const current = yield* ownedWorkspace(ownerUserId, workspaceId);
              yield* sql`UPDATE project_workspaces SET archived_at = now() WHERE id = ${workspaceId}::uuid AND archived_at IS NULL`;
              return create(ui.WorkspaceSchema, {
                id: workspaceId,
                projectId: current.project_id,
                workerId: current.worker_id,
                rootPath: current.root_path,
                label: current.label,
              });
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
                     WHERE pw.id = ${request.workspaceId}::uuid AND pw.project_id = ${request.projectId}::uuid
                       AND (pw.archived_at IS NULL OR ${request.parentThreadId !== ""}::boolean)`,
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
                  effort: request.effort,
                  permissionMode: permissionModeName(request.permissionMode) || "ASK",
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

          markThreadSeen: (ownerUserId, threadId, upToSeq) =>
            Effect.gen(function* () {
              const rows = yield* sql<{ seen_seq: string }>`
                INSERT INTO thread_reads (user_id, thread_id, seen_seq)
                SELECT t.owner_user_id, t.id, least(${upToSeq.toString()}::bigint, t.last_seq) FROM threads t
                 WHERE t.id = ${threadId}::uuid AND t.owner_user_id = ${ownerUserId}::uuid
                ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = EXCLUDED.seen_seq, seen_at = now()
                 WHERE thread_reads.seen_seq < EXCLUDED.seen_seq
                RETURNING seen_seq`;
              if (rows.length > 0) return true;
              yield* one(yield* sql<{ id: string }>`SELECT id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid`, "thread");
              return false;
            }),

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
              permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
              // Agent bus tools for every worker thread: Codex dynamicTools, Claude MCP (docs/agent-bus.md).
              enableAgentBus: row.runtime === "worker",
              providerThreadId: row.provider_thread_id ?? "",
              depth: row.depth,
            }),

          setThreadStatus: (threadId, status, detail) =>
            sql`UPDATE threads SET status = ${status}, status_detail = ${detail} WHERE id = ${threadId}::uuid`.pipe(Effect.asVoid),

          enqueueTurn: ({ threadId, text, userId, clientRequestId, model = "", effort = "", permissionMode = "", input }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const attachments = input?.attachments ?? [];
                if (!text.trim() && attachments.length === 0) return yield* Effect.fail(new Invalid("message is empty"));
                const id = Bun.randomUUIDv7();
                const rows = yield* sql<TurnRow>`
                  INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input, model, effort, permission_mode)
                  SELECT ${id}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'user', ${userId}::uuid,
                         ${clientRequestId || null}, ${JSON.stringify(input ?? { text })}::jsonb, ${model}, ${effort}, ${permissionMode}
                    FROM turns WHERE thread_id = ${threadId}::uuid
                  ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
                  RETURNING *`;
                if (!rows[0]) {
                  return yield* one(yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`, "turn");
                }
                if (attachments.length > 0) {
                  // Each attachment goes with one message: a concurrent send of the same file fails here and rolls back.
                  const bound = yield* sql`
                    UPDATE attachments SET thread_id = ${threadId}::uuid, turn_id = ${id}::uuid
                     WHERE id = ANY(${`{${attachments.map((a) => a.id).join(",")}}`}::uuid[]) AND owner_user_id = ${userId}::uuid AND thread_id IS NULL
                    RETURNING id`;
                  if (bound.length !== attachments.length) return yield* Effect.fail(new Invalid("an attachment was already sent with another message"));
                }
                return rows[0];
              }),
            ),

          turnByClientRequest: (threadId, clientRequestId) =>
            clientRequestId
              ? sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`.pipe(Effect.map((rows) => rows[0]))
              : Effect.succeed(undefined),

          updateThreadSettings: (threadId, settings) =>
            sql`
              UPDATE threads SET settings = settings || ${JSON.stringify(settings)}::jsonb WHERE id = ${threadId}::uuid AND archived_at IS NULL`.pipe(
              Effect.andThen(store.thread(threadId)),
            ),

          setTurnSettings: (turnId, { model, effort, permissionMode }) =>
            sql`UPDATE turns SET model = ${model}, effort = ${effort}, permission_mode = ${permissionMode} WHERE id = ${turnId}::uuid`.pipe(Effect.asVoid),

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

          failTurn: (turnId, error, source, code) =>
            sql`
              UPDATE turns SET status = 'failed', error = ${error}, error_source = ${source}, error_code = ${code || null}, completed_at = now()
               WHERE id = ${turnId}::uuid AND status IN ('queued', 'running')`.pipe(Effect.asVoid),

          expireEndedInteractions: (threadId) =>
            sql<InteractionRow>`
              UPDATE interaction_requests q SET status = 'expired', answered_at = now()
                FROM turns u
               WHERE u.id = q.turn_id AND q.thread_id = ${threadId}::uuid AND q.status = 'pending'
                 AND u.status IN ('completed', 'interrupted', 'failed', 'cancelled')
              RETURNING q.*`.pipe(Effect.map((rows) => rows.map(toInteraction))),

          endLostTurns: (input) =>
            sql.withTransaction(
              Effect.gen(function* () {
                // Only ids that can be turns here (a malformed report must not fail the reconcile).
                const keep = "keep" in input ? input.keep.map((t) => t.turnId).filter((id) => UUID.test(id)) : [];
                const only = "turnIds" in input ? [...input.turnIds] : null;
                const turns = yield* sql<{ id: string; thread_id: string }>`
                  UPDATE turns u SET status = 'interrupted', interrupt_source = 'system', interrupt_reason = ${input.reason}, completed_at = now()
                    FROM threads t
                   WHERE t.id = u.thread_id AND t.worker_id = ${input.workerId}::uuid AND t.runtime = 'worker' AND u.status = 'running'
                     AND (${only}::uuid[] IS NULL OR u.id = ANY(${only}::uuid[])) AND NOT (u.id = ANY(${keep}::uuid[]))
                  RETURNING u.id, u.thread_id`;
                if (turns.length === 0) return { turns: [], interactions: [] };
                const ids = turns.map((t) => t.id);
                const threads = [...new Set(turns.map((t) => t.thread_id))];
                yield* sql`
                  UPDATE threads t SET status = 'idle'
                   WHERE t.id = ANY(${threads}::uuid[]) AND t.status IN ('running', 'waiting_input')
                     AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')`;
                const interactions = yield* sql<InteractionRow>`
                  UPDATE interaction_requests SET status = 'expired', answered_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status = 'pending'
                  RETURNING *`;
                yield* sql`
                  UPDATE turn_steers SET status = 'dropped', reason = ${`the turn ended before the message could join it (${input.reason})`}, updated_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'accepted')`;
                return { turns: turns.map((t) => ({ threadId: t.thread_id, turnId: t.id })), interactions: interactions.map(toInteraction) };
              }),
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

/** A stored mode (PermissionMode enum name, as in threads.settings); '' or unknown = UNSPECIFIED. */
export function permissionModeOf(name: string | undefined): PermissionMode {
  const mode = PermissionMode[(name ?? "") as keyof typeof PermissionMode];
  return mode === undefined || mode === PermissionMode.UNSPECIFIED ? PermissionMode.UNSPECIFIED : mode;
}

/** The stored name of a mode; UNSPECIFIED = '' (the thread's default). */
export function permissionModeName(mode: PermissionMode): string {
  return mode === PermissionMode.UNSPECIFIED ? "" : (PermissionMode[mode] ?? "");
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
    effort: row.settings.effort ?? "",
    permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
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
    runtime: row.runtime,
    lastMessage: row.last_message ?? "",
    unseenResult: row.unseen_result ?? "",
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
    interruptReason: row.status === "interrupted" ? (row.interrupt_reason ?? "") : "",
    errorSource: row.status === "failed" ? (row.error_source ?? "") : "",
    errorCode: row.status === "failed" ? (row.error_code ?? "") : "",
    interruptSource: row.status === "interrupted" ? (row.interrupt_source ?? "") : "",
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
    model: row.model ?? "",
    effort: row.effort ?? "",
    permissionMode: permissionModeOf(row.permission_mode),
    goalId: row.goal_id ?? "",
    attachments: (row.input?.attachments ?? []).map(toUiAttachment),
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

