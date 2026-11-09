import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  AgentEnvironmentDesiredSchema,
  AgentEnvironmentReportSchema,
  type AgentEnvironmentReport,
  type CliToolsReport,
  type Hello,
  ui,
} from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import type { WorkerLink } from "../worker-link/index.ts";
import { automaticTags, checkDocument, compose, foreignWorkers, manualTags } from "./composition.ts";
import { documents, EnvironmentDatabase, revision, workers } from "./database.ts";
import { putDocument, removeDocument, setTags } from "./mutations.ts";
import { resolveDrift } from "./drift.ts";
import { skills, skillVersion } from "./skill-database.ts";
import { EnvironmentSkills } from "./skills.ts";
import { skillApplies } from "./skill-assignment.ts";
import { EnvironmentSources } from "./sources.ts";
import type { SourceOptions } from "./source-discovery.ts";
import { marketplaces, plugins } from "./plugin-database.ts";
import { EnvironmentMarketplaces } from "./marketplaces.ts";
import { EnvironmentPlugins, desiredPlugins } from "./plugins.ts";

export class AgentEnvironment {
  readonly db: EnvironmentDatabase;
  readonly skills: EnvironmentSkills;
  readonly sources: EnvironmentSources;
  readonly marketplaces: EnvironmentMarketplaces;
  readonly plugins: EnvironmentPlugins;

  constructor(
    readonly options: {
      runtime: CoreRuntime;
      userId: string;
      link: WorkerLink;
      changed: () => void;
      sources?: SourceOptions;
    },
  ) {
    this.db = new EnvironmentDatabase(options.runtime, options.userId);
    this.skills = new EnvironmentSkills(this);
    this.sources = new EnvironmentSources(this, options.sources);
    this.marketplaces = new EnvironmentMarketplaces(this);
    this.plugins = new EnvironmentPlugins(this);
  }

  async snapshot(request?: ui.AgentEnvironmentRequest): Promise<ui.AgentEnvironmentSnapshot> {
    const owner = this.options.userId;

    if (Boolean(request?.previewSkillId) !== Boolean(request?.previewSkillVersion))
      throw new ConnectError("Choose a skill and version to preview.", Code.InvalidArgument);

    const snapshot = await this.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO agent_environments (owner_user_id) VALUES (${owner}::uuid) ON CONFLICT DO NOTHING`;
            yield* sql`SELECT revision FROM agent_environments WHERE owner_user_id = ${owner}::uuid FOR SHARE`;

            const library = yield* skills(sql, owner);

            if (request?.previewSkillId && !library.some((skill) => skill.id === request.previewSkillId))
              return yield* Effect.fail(new ConnectError("Skill not found.", Code.NotFound));

            return create(ui.AgentEnvironmentSnapshotSchema, {
              revision: yield* revision(sql, owner),
              documents: yield* documents(sql, owner),
              workers: yield* workers(sql, owner),
              skills: library,
              previewSkillArtifact: request?.previewSkillId
                ? yield* skillVersion(sql, owner, request.previewSkillId, request.previewSkillVersion)
                : undefined,
              marketplaces: yield* marketplaces(sql, owner),
              plugins: yield* plugins(sql, owner),
            });
          }),
        );
      }),
    );

    for (const worker of snapshot.workers) {
      const connection = this.options.link.connections.get(worker.workerId);
      worker.online = Boolean(connection?.isOpen);
      worker.supported = connection?.isOpen
        ? connection.hello.capabilities.includes("agent_environment_v1")
        : worker.supported;
      worker.desiredRevision = snapshot.revision;
      worker.skillsSupported = connection?.isOpen
        ? connection.hello.capabilities.includes("agent_skills_v1")
        : worker.skillsSupported;
      worker.skillIds = snapshot.skills.filter((s) => skillApplies(s, worker)).map((s) => s.id);
      worker.pluginsSupported = connection?.isOpen
        ? connection.hello.capabilities.includes("agent_plugins_v1")
        : worker.pluginsSupported;
      worker.pluginIds = snapshot.plugins
        .filter((p) => p.assignment && skillApplies(p.assignment, worker))
        .map((p) => p.assignment!.id);

      try {
        worker.preview = compose(snapshot.documents, worker);

        if (worker.skillsSupported) await this.skills.desired(snapshot.skills, worker);

        if (worker.pluginsSupported) desiredPlugins(snapshot.plugins, worker);
      } catch (error) {
        worker.compositionError =
          error instanceof ConnectError ? error.rawMessage : "Couldn't compose this computer's instructions.";
      }
    }

    return snapshot;
  }

  /** `receipt` runs in the same transaction, after the document is saved (imports, docs/import.md "Blokady"). */
  async save(
    request: ui.SaveInstructionDocumentRequest,
    receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>,
  ): Promise<ui.AgentEnvironmentSnapshot> {
    if (!request.document) throw new ConnectError("Add an instruction document.", Code.InvalidArgument);
    const document = request.document;
    await this.db.mutate(
      request.expectedRevision,
      (sql, next) => putDocument(sql, this.options.userId, next, document),
      receipt,
    );

    return this.changed();
  }

  async remove(
    request: ui.DeleteInstructionDocumentRequest,
    receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>,
  ): Promise<ui.AgentEnvironmentSnapshot> {
    await this.db.mutate(
      request.expectedRevision,
      (sql, next) => removeDocument(sql, this.options.userId, next, request.id),
      receipt,
    );

    return this.changed();
  }

  async tags(request: ui.SetEnvironmentTagsRequest): Promise<ui.AgentEnvironmentSnapshot> {
    const tags = manualTags(request.tags);
    await this.db.mutate(request.expectedRevision, (sql) => setTags(sql, this.options.userId, request.workerId, tags));

    return this.changed();
  }

  async preview(request: ui.PreviewAgentEnvironmentRequest): Promise<ui.PreviewAgentEnvironmentResponse> {
    const snapshot = await this.snapshot();
    const worker = snapshot.workers.find((w) => w.workerId === request.workerId);

    if (!worker) throw new ConnectError("Worker not found.", Code.NotFound);
    let library = snapshot.documents;

    if (request.draft) {
      const draft = request.draft;
      const saved = library.find((d) => d.id === draft.id);

      checkDocument(
        draft,
        snapshot.workers,
        foreignWorkers([saved?.selector, ...(saved?.fragments ?? []).map((f) => f.selector)], snapshot.workers),
      );

      if (draft.id && !library.some((d) => d.id === draft.id))
        throw new ConnectError("Document not found.", Code.NotFound);
      library = draft.id ? library.map((d) => (d.id === draft.id ? draft : d)) : [...library, draft];
    }

    return create(ui.PreviewAgentEnvironmentResponseSchema, { instructions: compose(library, worker) });
  }

  async resolve(request: ui.ResolveEnvironmentDriftRequest): Promise<ui.AgentEnvironmentSnapshot> {
    await this.db.mutate(request.expectedRevision, (sql, next) =>
      resolveDrift(sql, this.options.userId, next, request),
    );

    return this.changed();
  }

  async changed(): Promise<ui.AgentEnvironmentSnapshot> {
    const snapshot = await this.sync();
    this.options.changed();

    return snapshot;
  }

  async sync(workerId?: string): Promise<ui.AgentEnvironmentSnapshot> {
    const snapshot = await this.snapshot();

    for (const worker of snapshot.workers) {
      if (workerId && worker.workerId !== workerId) continue;

      if (worker.compositionError) continue;
      const connection = this.options.link.connections.get(worker.workerId);

      if (!connection?.isOpen || !connection.hello.capabilities.includes("agent_environment_v1")) continue;

      const pending = await this.db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* sql<{
            resolutions: JsonValue;
          }>`SELECT resolutions FROM worker_environments WHERE worker_id = ${worker.workerId}::uuid`;

          return fromJson(AgentEnvironmentDesiredSchema, rows[0]?.resolutions ?? {});
        }),
      );

      connection.send({
        case: "agentEnvironment",
        value: {
          revision: snapshot.revision,
          instructions: worker.preview,
          resolutions: pending.resolutions,
          skills: connection.hello.capabilities.includes("agent_skills_v1")
            ? await this.skills.desired(snapshot.skills, worker)
            : [],
          skillResolutions: connection.hello.capabilities.includes("agent_skills_v1") ? pending.skillResolutions : [],
          plugins: connection.hello.capabilities.includes("agent_plugins_v1")
            ? desiredPlugins(snapshot.plugins, worker)
            : [],
          pluginResolutions: connection.hello.capabilities.includes("agent_plugins_v1")
            ? pending.pluginResolutions
            : [],
        },
      });
    }

    return snapshot;
  }

  /** The authenticated Hello supplies facts. Manual tags are never overwritten by discovery. */
  async connected(workerId: string, hello: Hello, tools?: CliToolsReport): Promise<void> {
    let tags = automaticTags(hello);

    if (tools) {
      tags = tags.filter((tag) => !tag.startsWith("cli:"));

      for (const tool of tools.tools) {
        const harness = ["", "claude", "codex", "grok"][tool.provider];

        if (tool.path && tool.version && harness) tags.push(`cli:${harness}`);
      }

      tags.sort();
    }

    const automatic = tags;
    const supported = hello.capabilities.includes("agent_environment_v1");
    const skillsSupported = hello.capabilities.includes("agent_skills_v1");
    const pluginsSupported = hello.capabilities.includes("agent_plugins_v1");
    const owner = this.options.userId;

    const changed = await this.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const owned =
              yield* sql`SELECT id FROM workers WHERE id = ${workerId}::uuid AND owner_user_id = ${owner}::uuid AND revoked_at IS NULL AND archived_at IS NULL`;

            if (!owned.length) return false;
            yield* sql`INSERT INTO agent_environments (owner_user_id) VALUES (${owner}::uuid) ON CONFLICT DO NOTHING`;
            yield* sql`SELECT revision FROM agent_environments WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;

            const updated =
              yield* sql`INSERT INTO worker_environments (worker_id, automatic_tags, supported, skills_supported, plugins_supported)
          VALUES (${workerId}::uuid, ${automatic}::text[], ${supported}, ${skillsSupported}, ${pluginsSupported})
          ON CONFLICT (worker_id) DO UPDATE SET automatic_tags = EXCLUDED.automatic_tags, supported = EXCLUDED.supported, skills_supported = EXCLUDED.skills_supported, plugins_supported = EXCLUDED.plugins_supported
          WHERE worker_environments.automatic_tags IS DISTINCT FROM EXCLUDED.automatic_tags OR worker_environments.supported <> EXCLUDED.supported OR worker_environments.skills_supported <> EXCLUDED.skills_supported OR worker_environments.plugins_supported <> EXCLUDED.plugins_supported
          RETURNING worker_id`;

            if (updated.length)
              yield* sql`UPDATE agent_environments SET revision = revision + 1 WHERE owner_user_id = ${owner}::uuid`;

            return updated.length > 0;
          }),
        );
      }),
    );

    await this.sync(changed ? undefined : workerId);
    this.options.changed();
  }

  async report(workerId: string, report: AgentEnvironmentReport): Promise<void> {
    // Bound an authenticated but untrusted worker's report before persisting or exposing any block to the UI.
    if (
      report.files.length > 128 ||
      report.skills.length > 512 ||
      report.plugins.length > 512 ||
      Buffer.byteLength(JSON.stringify(toJson(AgentEnvironmentReportSchema, report))) > 128 * 1024 * 1024
    )
      return;
    const owner = this.options.userId;
    const json = JSON.stringify(toJson(AgentEnvironmentReportSchema, report));
    await this.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT revision FROM agent_environments WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;
            const current = yield* revision(sql, owner);

            if (report.revision > current) return;
            yield* sql`UPDATE worker_environments e SET report = ${json}::jsonb, reported_at = now(),
          resolutions = CASE WHEN ${report.revision} = ${current} THEN '{}'::jsonb ELSE resolutions END
          FROM workers w WHERE w.id = e.worker_id AND w.id = ${workerId}::uuid AND w.owner_user_id = ${owner}::uuid
          AND COALESCE((e.report->>'revision')::bigint, 0) <= ${report.revision}`;
          }),
        );
      }),
    );
    this.options.changed();
  }
}
