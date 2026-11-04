import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { canAutoUpdate } from "@canopy/domain/skill-source";
import { audit, workers } from "./database.ts";
import { checked } from "./mutations.ts";
import { checkSkillAssignment, desiredSkills } from "./skill-assignment.ts";
import { addSkillVersion, saveSkillDefinition, skills } from "./skill-database.ts";
import { parseSourceCommand } from "./source-command.ts";
import { SourceDatabase, sourcePolicy } from "./source-database.ts";
import { discoverSource, type SourceOptions } from "./source-discovery.ts";
import type { AgentEnvironment } from "./service.ts";

export class EnvironmentSources {
  readonly db: SourceDatabase;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #busy = false;
  #fetching = false;
  #abort = new AbortController();
  #pending = new Set<Promise<unknown>>();

  constructor(
    readonly environment: AgentEnvironment,
    readonly options: SourceOptions = {},
  ) {
    this.db = new SourceDatabase(environment);
  }

  private async track<A>(operation: () => Promise<A>): Promise<A> {
    this.#abort.signal.throwIfAborted();
    const pending = operation();
    this.#pending.add(pending);

    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }

  private async fetch(parsed: ReturnType<typeof parseSourceCommand>, command = "") {
    if (this.#fetching)
      throw new ConnectError("A source is already being resolved. Try again when it finishes.", Code.ResourceExhausted);
    this.#fetching = true;

    try {
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]);

      const result = await discoverSource(
        parsed,
        await this.db.authorization(parsed.source),
        { ...this.options, signal },
        command,
      );

      this.#abort.signal.throwIfAborted();

      return result;
    } finally {
      this.#fetching = false;
    }
  }

  preview(request: ui.PreviewSkillSourceRequest) {
    return this.track(() => this.previewSource(request));
  }

  private async previewSource(request: ui.PreviewSkillSourceRequest) {
    const parsed = parseSourceCommand(request.command);
    parsed.source.credentialAccountId = request.credentialAccountId;
    let preview;

    try {
      preview = await this.fetch(parsed, request.command);
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError(
        "Couldn't resolve this source. Check its ref, layout, limits and connector access.",
        Code.InvalidArgument,
      );
    }

    await this.db.save(preview);

    return preview;
  }

  async add(request: ui.AddSkillSourceRequest) {
    const preview = await this.db.load(request.previewId);

    if (
      preview.skillId ||
      !preview.source ||
      !request.assignment ||
      !request.paths.length ||
      new Set(request.paths).size !== request.paths.length ||
      request.paths.some((p) => !preview.skills.some((s) => s.path === p))
    )
      throw new ConnectError("Select skills from an import preview and choose their assignment.", Code.InvalidArgument);
    await this.db.authorization(preview.source); // A deleted/disconnected credential cannot authorize an old preview.
    const selected = preview.skills.filter((s) => request.paths.includes(s.path));
    const owner = this.environment.options.userId;
    const source = preview.source;
    const assignment = request.assignment;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const library = yield* skills(sql, owner);

        if (library.length + selected.length > 100)
          return yield* Effect.fail(new ConnectError("Use at most 100 skills.", Code.InvalidArgument));
        const machines = yield* workers(sql, owner);

        for (const item of selected) {
          if (!item.artifact) return yield* Effect.fail(new ConnectError("Invalid preview artifact.", Code.Internal));

          const saved = create(ui.LibrarySkillSchema, {
            ...assignment,
            id: Bun.randomUUIDv7(),
            name: selected.length === 1 && assignment.name ? assignment.name : item.artifact.name,
            version: 1n,
            versions: [1n],
            artifact: item.artifact,
            overrides: [],
            source: { ...sourcePolicy(source, source.commit), path: item.path, autoUpdate: false, pinned: false },
          });

          yield* checked(() => checkSkillAssignment(saved, machines));
          yield* addSkillVersion(sql, owner, saved.id, 1n, item.artifact, source.commit);
          library.push(saved);
          yield* saveSkillDefinition(sql, owner, saved);
          yield* audit(sql, owner, "environment.source.add", saved.id);
        }

        for (const machine of machines) yield* desiredSkills(sql, owner, library, machine);
        yield* sql`DELETE FROM agent_skill_source_previews WHERE id = ${preview.id}::uuid AND owner_user_id = ${owner}::uuid`;
      }),
    );

    return this.environment.changed();
  }

  check(request: ui.CheckSkillSourceRequest) {
    return this.track(() => this.checkSource(request));
  }

  private async checkSource(request: ui.CheckSkillSourceRequest) {
    const snapshot = await this.environment.snapshot();
    const skill = snapshot.skills.find((s) => s.id === request.id);

    if (!skill?.source) throw new ConnectError("Source skill not found.", Code.NotFound);

    const parsed = {
      source: clone(ui.SkillSourceSchema, skill.source),
      names: [],
      fullDepth: false,
      filter: "",
      deviceHome: skill.deviceHome,
      harnesses: skill.harnesses,
      notices: [],
    };

    let preview;

    try {
      preview = await this.fetch(parsed);

      if (preview.skills.length !== 1 || preview.skills[0]?.artifact?.name !== skill.artifact?.name)
        throw new Error("Source skill identity changed.");
    } catch (error) {
      if (this.#abort.signal.aborted || (error instanceof ConnectError && error.code === Code.ResourceExhausted))
        throw new ConnectError("Source check interrupted. Retry after the current operation.", Code.Canceled);
      await this.recordCheck(skill.id, snapshot.revision, undefined);
      throw new ConnectError(
        "Couldn't check upstream. The installed version is unchanged. Check source access and retry.",
        Code.Unavailable,
      );
    }

    preview.skillId = skill.id;
    preview.baseChecksum = skill.artifact?.checksum ?? "";
    await this.db.save(preview);
    await this.recordCheck(skill.id, snapshot.revision, preview);

    return preview;
  }

  private async recordCheck(id: string, revision: bigint, preview: ui.SkillSourcePreview | undefined) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(revision, (sql) =>
      Effect.gen(function* () {
        const skill = (yield* skills(sql, owner)).find((s) => s.id === id);

        if (!skill?.source) return yield* Effect.fail(new ConnectError("Source skill not found.", Code.NotFound));
        skill.source.checkedAt = new Date().toISOString();
        skill.source.error = preview ? "" : "Upstream check failed. The installed version is unchanged.";
        const changed = preview?.source?.commit !== skill.source.commit;
        skill.source.availableCommit = preview && changed ? (preview.source?.commit ?? "") : "";
        skill.source.updatePreviewId = preview && changed ? preview.id : "";
        yield* saveSkillDefinition(sql, owner, skill);
      }),
    );
    await this.environment.changed();
  }

  async apply(request: ui.ApplySkillSourceRequest, automatic = false) {
    const preview = await this.db.load(request.previewId);
    const candidate = preview.skills[0];

    if (preview.skillId !== request.id || !preview.source || preview.skills.length !== 1 || !candidate?.artifact)
      throw new ConnectError("Choose an update preview for this skill.", Code.InvalidArgument);
    await this.db.authorization(preview.source);
    const source = preview.source;
    const artifact = candidate.artifact;
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const library = yield* skills(sql, owner);
        const saved = library.find((s) => s.id === request.id);

        if (!saved?.source || !saved.artifact)
          return yield* Effect.fail(new ConnectError("Source skill not found.", Code.NotFound));

        if (
          saved.source.url !== source.url ||
          saved.source.ref !== source.ref ||
          saved.source.path !== candidate.path ||
          saved.source.credentialAccountId !== source.credentialAccountId ||
          saved.artifact.checksum !== preview.baseChecksum ||
          saved.artifact.name !== artifact.name
        )
          return yield* Effect.fail(
            new ConnectError("The skill changed after preview. Check upstream again.", Code.FailedPrecondition),
          );

        if (automatic && (!saved.source.autoUpdate || saved.source.pinned || !canAutoUpdate(saved.artifact, artifact)))
          return yield* Effect.fail(
            new ConnectError("This update requires an owner's review.", Code.FailedPrecondition),
          );
        saved.version = (saved.versions.at(-1) ?? 0n) + 1n;
        saved.versions.push(saved.version);
        saved.artifact = artifact;
        saved.source = sourcePolicy(saved.source, source.commit);
        yield* addSkillVersion(sql, owner, saved.id, saved.version, artifact, source.commit);
        const machines = yield* workers(sql, owner);
        yield* checked(() => checkSkillAssignment(saved, machines));

        for (const machine of machines) yield* desiredSkills(sql, owner, library, machine);
        yield* saveSkillDefinition(sql, owner, saved);
        yield* audit(sql, owner, automatic ? "environment.source.auto-update" : "environment.source.update", saved.id);
        yield* sql`DELETE FROM agent_skill_source_previews WHERE id = ${preview.id}::uuid AND owner_user_id = ${owner}::uuid`;
      }),
    );

    return this.environment.changed();
  }

  /** Hourly checks are serialized. Source state and frozen candidates survive gateway restarts. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;

    try {
      const initial = await this.environment.snapshot();

      for (const skill of initial.skills) {
        if (this.#abort.signal.aborted) break;

        if (!skill.source || skill.source.pinned || now - Date.parse(skill.source.checkedAt || "1970-01-01") < 3600_000)
          continue;

        try {
          const preview = await this.check(create(ui.CheckSkillSourceRequestSchema, { id: skill.id }));
          const snapshot = await this.environment.snapshot();
          const current = snapshot.skills.find((s) => s.id === skill.id);
          const artifact = preview.skills[0]?.artifact;

          if (
            current?.source?.autoUpdate &&
            !current.source.pinned &&
            current.source.availableCommit &&
            current.artifact &&
            artifact &&
            canAutoUpdate(current.artifact, artifact)
          )
            await this.apply(
              create(ui.ApplySkillSourceRequestSchema, {
                id: skill.id,
                previewId: preview.id,
                expectedRevision: snapshot.revision,
              }),
              true,
            );
        } catch {
          /* Per-item errors are persisted without leaking remote diagnostics; retry on a later tick. */
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  start(): void {
    if (this.#abort.signal.aborted) this.#abort = new AbortController();

    const run = () => {
      if (this.#running) return;
      this.#running = this.tick()
        .catch(() => {})
        .finally(() => {
          this.#running = undefined;
        });
    };

    run();
    this.#timer ??= setInterval(run, 60_000);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled([...this.#pending, ...(this.#running ? [this.#running] : [])]);
  }
}
