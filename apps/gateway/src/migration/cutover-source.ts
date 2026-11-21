import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { loadSecretsKey } from "../store/secrets.ts";
import { exportBundle, verifyBundle } from "./bundle.ts";
import {
  CutoverError,
  readCutoverFile,
  requireStorageSpace,
  withCutoverLock,
  writeCutoverFile,
} from "./cutover-files.ts";
import {
  cutoverService,
  hostFields,
  recoverCutoverService,
  resolveCutoverHost,
  type CutoverHost,
} from "./cutover-host.ts";
import {
  bundleRequest,
  cutoverDigest,
  cutoverRunId,
  trialProofSchema,
  type CutoverTargetState,
} from "./cutover-protocol.ts";
import { sshConfig, sshCutover, type SshConfig } from "./cutover-ssh.ts";
import { inspectDatabaseCapacity, type DatabaseCapacity } from "./postgres.ts";
import { abortFence, commitSourceFence, readFence, requestDrain } from "./relocation-fence.ts";

const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...hostFields,
      target: sshConfig,
      drainTimeoutSeconds: Schema.optional(
        Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86400 })),
      ),
    }),
  ),
  { onExcessProperty: "error" },
);

const elapsedTime = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const stateSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: cutoverRunId,
  destination: Schema.String,
  port: Schema.Number,
  restartOnAbort: Schema.Boolean,
  phase: Schema.Literals([
    "preparing",
    "trialed",
    "draining",
    "exported",
    "restored",
    "committed",
    "active",
    "aborting",
    "aborted",
  ]),
  trialArchiveSha256: Schema.optional(cutoverDigest),
  trialExportMs: Schema.optional(elapsedTime),
  trialRequestMs: Schema.optional(elapsedTime),
  trial: Schema.optional(trialProofSchema),
  drainMs: Schema.optional(elapsedTime),
  drainStartedAt: Schema.optional(elapsedTime),
  archiveSha256: Schema.optional(cutoverDigest),
  finalExportMs: Schema.optional(elapsedTime),
  finalRestoreMs: Schema.optional(elapsedTime),
  activationMs: Schema.optional(elapsedTime),
  targetCleanupPending: Schema.optional(Schema.Boolean),
});

type SourceState = typeof stateSchema.Type;

type SourceRequest =
  | { action: "status" | "abort" }
  | ({ action: "prepare" } & DatabaseCapacity)
  | { action: "activate"; archiveSha256: string };

export type SourceAction = "start" | "resume" | "status" | "abort";

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(stateSchema), { onExcessProperty: "error" });

export async function runCutoverSource(configPath: string, env: NodeJS.ProcessEnv, action: SourceAction) {
  const config = await readCutoverFile(configPath, decodeConfig);

  if (!config) throw new CutoverError("Create the private source cutover configuration file.");

  const host = await resolveCutoverHost(config, env);

  return withCutoverLock(host.stateDirectory, async () => {
    const cutover = new SourceCutover(host, config.target, (config.drainTimeoutSeconds ?? 300) * 1000);

    return cutover.run(action);
  });
}

class SourceCutover {
  #host: CutoverHost;
  #target: SshConfig;
  #drainTimeout: number;
  #file: string;
  #trialBundle: string;
  #finalBundle: string;

  constructor(host: CutoverHost, target: SshConfig, drainTimeout: number) {
    this.#host = host;
    this.#target = target;
    this.#drainTimeout = drainTimeout;
    this.#file = join(host.stateDirectory, "move-source.json");
    this.#trialBundle = join(host.stateDirectory, "trial-bundle");
    this.#finalBundle = join(host.stateDirectory, "final-bundle");
  }

  async #save(state: SourceState) {
    await writeCutoverFile(this.#file, JSON.stringify(state));

    return state;
  }

  #key() {
    try {
      return loadSecretsKey(this.#host.env).toString("base64");
    } catch {
      throw new CutoverError("Load the source gateway's existing CANOPY_SECRETS_KEY.");
    }
  }

  async #request(state: SourceState, payload: SourceRequest) {
    const reply = await sshCutover(this.#target, { version: 1, runId: state.runId, ...payload });

    return this.#matchingTarget(state, reply);
  }

  #matchingTarget(state: SourceState, target: CutoverTargetState) {
    if (target.runId !== state.runId) throw new CutoverError("The target response belongs to a different cutover.");

    return target;
  }

  async #sendBundle(state: SourceState, action: "trial" | "import", dir: string) {
    return this.#matchingTarget(
      state,
      await sshCutover(this.#target, bundleRequest(action, state.runId, dir, this.#key())),
    );
  }

  async #new(): Promise<SourceState> {
    this.#key();
    const fence = await readFence(this.#host.env);

    if (fence) throw new CutoverError("The source database is already fenced. Resume its existing cutover.");

    return this.#save({
      version: 1,
      runId: randomUUID(),
      destination: this.#target.destination,
      port: this.#target.port ?? 22,
      restartOnAbort: !(await cutoverService(this.#host).stopped()),
      phase: "preparing",
    });
  }

  async #trial(state: SourceState) {
    const capacity = await inspectDatabaseCapacity(this.#host.env);
    await requireStorageSpace(this.#host.stateDirectory, BigInt(capacity.databaseBytes));
    const prepared = await this.#request(state, { action: "prepare", ...capacity });
    let current = state;
    let target = prepared;
    let trialRequestMs = 0;

    if (prepared.phase === "prepared") {
      if (!current.trialArchiveSha256) {
        await rm(this.#trialBundle, { recursive: true, force: true });
        const started = performance.now();
        const manifest = await exportBundle(this.#host.env, this.#trialBundle);
        current = await this.#save({
          ...current,
          trialArchiveSha256: manifest.archiveSha256,
          trialExportMs: elapsed(started),
        });
      }

      const began = performance.now();
      target = await this.#sendBundle(current, "trial", this.#trialBundle);
      trialRequestMs = elapsed(began);
    }

    if (target.phase !== "trialed" || !target.trial || target.trial.archiveSha256 !== current.trialArchiveSha256)
      throw new CutoverError("The destination did not confirm the matching isolated trial restore.");

    const finished = await this.#save({ ...current, phase: "trialed", trial: target.trial, trialRequestMs });
    await rm(this.#trialBundle, { recursive: true, force: true });

    return finished;
  }

  async #drain(state: SourceState) {
    const { env } = this.#host;
    await requestDrain(env, state.runId);
    const deadline = performance.now() + this.#drainTimeout;

    for (;;) {
      const fence = await readFence(env);

      if (fence?.operationId !== state.runId || fence.state === "committed")
        throw new CutoverError("The source database does not have the expected drain fence.");

      if (fence.state === "drained") break;

      if (performance.now() >= deadline)
        throw new CutoverError(
          "The source is still draining. Resume after active work has finished or abort the cutover.",
        );

      await Bun.sleep(500);
    }

    const service = cutoverService(this.#host);
    await service.stop();

    if (!(await service.stopped())) throw new CutoverError("The source gateway service is still running.");

    return Math.max(0, Date.now() - (state.drainStartedAt ?? Date.now()));
  }

  async #exportFinal(state: SourceState) {
    const drainMs = await this.#drain(state);
    const began = performance.now();
    await rm(this.#finalBundle, { recursive: true, force: true });
    const manifest = await exportBundle(this.#host.env, this.#finalBundle, true);

    return this.#save({
      ...state,
      phase: "exported",
      archiveSha256: manifest.archiveSha256,
      drainMs,
      finalExportMs: elapsed(began),
    });
  }

  async #restore(state: SourceState) {
    const began = performance.now();
    let target = await this.#request(state, { action: "status" });

    if (target.phase === "trialed") {
      const fence = await readFence(this.#host.env);

      if (fence?.operationId !== state.runId || fence.state !== "drained")
        throw new CutoverError("The source drain fence is no longer held.");

      const manifest = await verifyBundle(this.#host.env, this.#finalBundle);

      if (manifest.archiveSha256 !== state.archiveSha256)
        throw new CutoverError("The local final bundle differs from the journaled export.");

      target = await this.#sendBundle(state, "import", this.#finalBundle);
    }

    if (target.phase !== "restored" || !state.archiveSha256 || target.archiveSha256 !== state.archiveSha256)
      throw new CutoverError("The target has not confirmed restoration of the matching final archive.");

    return this.#save({ ...state, phase: "restored", finalRestoreMs: elapsed(began) });
  }

  async #commit(state: SourceState) {
    const target = await this.#request(state, { action: "status" });

    if (target.phase !== "restored" || target.archiveSha256 !== state.archiveSha256)
      throw new CutoverError("The matching restored destination must be available before committing the source.");

    await commitSourceFence(this.#host.env, state.runId);

    return this.#save({ ...state, phase: "committed" });
  }

  async #activate(state: SourceState) {
    const { archiveSha256 } = state;
    const fence = await readFence(this.#host.env);

    if (!archiveSha256 || fence?.operationId !== state.runId || fence.state !== "committed")
      throw new CutoverError("A durable source commitment is required before target activation.");

    const began = performance.now();
    let target = await this.#request(state, { action: "status" });

    if (target.archiveSha256 !== archiveSha256)
      throw new CutoverError("The target's archive does not match the committed source.");

    if (target.phase === "restored" || target.phase === "activating")
      target = await this.#request(state, { action: "activate", archiveSha256 });

    if (target.phase !== "active" || target.archiveSha256 !== archiveSha256)
      throw new CutoverError("Target activation could not be confirmed. Resume the cutover to reconcile both hosts.");

    const active = await this.#save({ ...state, phase: "active", activationMs: elapsed(began) });
    await this.#clean();

    return { ...active, targetPhase: target.phase };
  }

  async #abort(state: SourceState) {
    const { env } = this.#host;
    const fence = await readFence(env);

    if (["committed", "active"].includes(state.phase) || fence?.state === "committed")
      throw new CutoverError("The source was permanently committed. Resume to reconcile the destination.");

    if (fence && fence.operationId !== state.runId)
      throw new CutoverError("The source database is fenced by a different operation.");

    const target = await this.#request(state, { action: "status" }).catch(() => undefined);

    if (target?.phase === "activating" || target?.phase === "active")
      throw new CutoverError("The destination may have received writes. Keep the source fenced.");

    if (state.phase !== "aborted")
      state = await this.#save({ ...state, phase: "aborting", targetCleanupPending: true });

    if (state.drainStartedAt !== undefined) {
      const { shuttingDown } = await abortFence(env, state.runId);

      if (state.restartOnAbort)
        await recoverCutoverService(
          cutoverService(this.#host),
          shuttingDown,
          "Source restart is pending. Resume the abort.",
        );
    }

    if (state.phase !== "aborted") state = await this.#save({ ...state, phase: "aborted" });

    await this.#clean();
    const cleanup = await this.#request(state, { action: "abort" }).catch(() => undefined);

    return this.#save({ ...state, targetCleanupPending: cleanup?.phase !== "aborted" });
  }

  async #clean() {
    await Promise.all([
      rm(this.#trialBundle, { recursive: true, force: true }),
      rm(this.#finalBundle, { recursive: true, force: true }),
    ]);
  }

  async run(action: SourceAction) {
    let state = await readCutoverFile(this.#file, decodeState);

    if (!state) {
      if (action !== "start") throw new CutoverError("No source cutover is recorded in this directory.");
      state = await this.#new();
    }

    if (state.destination !== this.#target.destination || state.port !== (this.#target.port ?? 22))
      throw new CutoverError("The SSH destination differs from the journaled cutover.");

    if (action === "abort" || (action === "resume" && (state.phase === "aborting" || state.phase === "aborted")))
      return this.#abort(state);

    if (action === "status") {
      const fence = await readFence(this.#host.env);
      const target = await this.#request(state, { action: "status" }).catch(() => undefined);

      return { ...state, fence: fence?.state, targetPhase: target?.phase ?? "unreachable" };
    }

    if (state.phase === "preparing") return this.#trial(state);

    if (action === "start") return state;

    if (state.phase === "trialed") {
      const target = await this.#request(state, { action: "status" });

      if (target.phase !== "trialed" || target.trial?.archiveSha256 !== state.trial?.archiveSha256)
        throw new CutoverError("The destination no longer confirms the isolated trial restore.");

      state = await this.#save({ ...state, phase: "draining", drainStartedAt: Date.now() });
    }

    if (state.phase === "draining") state = await this.#exportFinal(state);

    if (state.phase === "exported") state = await this.#restore(state);

    if (state.phase === "restored") state = await this.#commit(state);

    if (state.phase === "committed") return this.#activate(state);

    if (state.phase === "active") await this.#clean();

    return state;
  }
}

function elapsed(started: number) {
  return Math.round(performance.now() - started);
}
