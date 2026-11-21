import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isStandalone } from "@canopy/updater";
import { Schema } from "effect";
import { importBundle, verifyBundle } from "./bundle.ts";
import { cutoverRoutes, installDesktopDevice, verifyCutoverRoutes } from "./cutover-desktop.ts";
import {
  CutoverError,
  readCutoverFile,
  requireStorageSpace,
  withCutoverLock,
  writeCutoverFile,
} from "./cutover-files.ts";
import {
  cutoverService,
  installTargetKey,
  loadCutoverHost,
  targetConfigPath,
  type CutoverHost,
  waitForCutoverService,
} from "./cutover-host.ts";
import {
  CutoverInput,
  cutoverKey,
  desktopDeviceSchema,
  targetStateSchema,
  type CutoverTargetState,
  type DesktopCutoverDevice,
  type JoinRequest,
  type MoveRequest,
} from "./cutover-protocol.ts";
import {
  inspectDatabase,
  inspectTrialSample,
  preflightDatabase,
  readRestoreReceipt,
  withTrialDatabase,
} from "./postgres.ts";
import { clearImportedFence, readFence } from "./relocation-fence.ts";

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(targetStateSchema), {
  onExcessProperty: "error",
});

const decodeDevice = Schema.decodeUnknownSync(Schema.fromJsonString(desktopDeviceSchema), {
  onExcessProperty: "error",
});

type Upload = Extract<MoveRequest, { key: string }>;

function isJoinRequest(request: MoveRequest | JoinRequest): request is JoinRequest {
  return request.action.startsWith("join-");
}

export async function handleCutoverTarget(env: NodeJS.ProcessEnv, stream: ReadableStream<Uint8Array>) {
  const input = new CutoverInput(stream);
  const request = await input.request();

  if (isJoinRequest(request)) {
    const { joinTarget } = await import("./consolidation-target.ts");

    return joinTarget(request, input, env);
  }

  const host = await loadCutoverHost(targetConfigPath(env), env);

  return withCutoverLock(host.stateDirectory, async () => {
    const target = new TargetCutover(host, request.runId);

    if (request.action !== "import" && request.action !== "trial") await input.end();

    const result = await target.run(request, input);

    // The archive digest is only a confirmation after the restore transaction has a matching receipt.
    if (result.phase === "trialed") {
      const { archiveSha256: _pending, ...report } = result;

      return report;
    }

    return result;
  });
}

class TargetCutover {
  #host: CutoverHost;
  #runId: string;
  #file: string;
  #pendingKey: string;

  constructor(host: CutoverHost, runId: string) {
    this.#host = host;
    this.#runId = runId;
    this.#file = join(host.stateDirectory, "move-target.json");
    this.#pendingKey = join(host.stateDirectory, "pending-gateway-key");
  }

  async #save(state: CutoverTargetState) {
    await writeCutoverFile(this.#file, JSON.stringify(state));

    return state;
  }

  async #state(): Promise<CutoverTargetState> {
    const state = await readCutoverFile(this.#file, decodeState);

    if (state && state.runId !== this.#runId)
      throw new CutoverError("The target cutover directory already belongs to a different run.");

    return state ?? { version: 1, runId: this.#runId, phase: "absent" };
  }

  async #requireStopped() {
    if (!(await cutoverService(this.#host).stopped()))
      throw new CutoverError("Stop the destination gateway and block automatic startup before preparing the database.");
  }

  async #prepare(state: CutoverTargetState, request: Extract<MoveRequest, { action: "prepare" }>) {
    if (state.phase === "aborted") throw new CutoverError("This target cutover has been aborted.");

    if (state.phase !== "absent") return state;
    await this.#requireStopped();
    await preflightDatabase(this.#host.env, request);
    await requireStorageSpace(this.#host.stateDirectory, BigInt(request.databaseBytes) * 2n);

    if ((await readCutoverFile(this.#host.secretFile, (key) => key, 128)) !== undefined)
      throw new CutoverError("Use a new target gateway key file for the cutover.");

    return this.#save({ ...state, phase: "prepared" });
  }

  async #confirmedRestore(state: CutoverTargetState) {
    if (!state.archiveSha256 || state.phase === "aborted") return state;
    const receipt = await readRestoreReceipt(this.#host.env, this.#runId);

    if (!receipt && state.phase === "trialed") return state;

    if (receipt?.archiveSha256 !== state.archiveSha256)
      throw new CutoverError("The destination restore receipt does not match this cutover.");

    if (state.phase !== "trialed" && state.phase !== "restored") return state;
    const fence = await readFence(this.#host.env);

    if (fence?.operationId !== this.#runId || fence.state !== "drained")
      throw new CutoverError("The restored destination must remain fenced until activation.");

    if (state.phase === "restored") return state;
    const key = await this.#readKey();
    await inspectDatabase({ ...this.#host.env, CANOPY_SECRETS_KEY: key });

    return this.#save({ ...state, phase: "restored" });
  }

  async #readKey() {
    const key = await readCutoverFile(this.#pendingKey, (value) => value, 64);

    if (!Schema.is(cutoverKey)(key))
      throw new CutoverError("The private key transfer for the restored gateway is missing.");

    return key;
  }

  async #upload(state: CutoverTargetState, request: Upload, input: CutoverInput) {
    if (
      state.phase === "absent" ||
      state.phase === "aborted" ||
      state.phase === "activating" ||
      state.phase === "active"
    )
      throw new CutoverError("The target cutover cannot receive a bundle in its current phase.");

    await this.#requireStopped();
    const directory = join(this.#host.stateDirectory, "incoming");
    await rm(directory, { recursive: true, force: true });
    const began = performance.now();

    try {
      await input.receiveBundle(directory, request);
      const receiveMs = elapsed(began);
      const env = { ...this.#host.env, CANOPY_SECRETS_KEY: request.key };

      if (request.action === "trial") return await this.#trial(state, env, directory, receiveMs);

      return await this.#restore(state, env, directory, request.key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #trial(state: CutoverTargetState, env: NodeJS.ProcessEnv, directory: string, receiveMs: number) {
    if (state.phase !== "prepared") return state;

    const trial = await withTrialDatabase(env, this.#runId, async (trialEnv) => {
      const restoring = performance.now();
      const manifest = await importBundle(trialEnv, directory, { stagingDirectory: directory });
      const restoreMs = elapsed(restoring);
      const verifying = performance.now();
      const snapshot = await inspectDatabase(trialEnv);
      const sample = await inspectTrialSample(trialEnv);

      return {
        archiveSha256: manifest.archiveSha256,
        postgresMajor: snapshot.postgresMajor,
        schemaMigration: snapshot.schemaMigration,
        nodeId: snapshot.nodeId,
        certificateSha256: snapshot.certificateSha256,
        receiveMs,
        restoreMs,
        verifyMs: elapsed(verifying),
        sample,
      };
    });

    const routes = cutoverRoutes(this.#host, trial.certificateSha256);

    return this.#save({ ...state, phase: "trialed", trial, routes });
  }

  async #restore(state: CutoverTargetState, env: NodeJS.ProcessEnv, directory: string, key: string) {
    const trial = state.trial;

    if (!trial) throw new CutoverError("Complete the isolated restore trial before sending the final bundle.");

    const manifest = await verifyBundle(env, directory);
    const { archiveSha256, database } = manifest;

    if (
      database.schemaMigration !== trial.schemaMigration ||
      database.nodeId !== trial.nodeId ||
      database.certificateSha256 !== trial.certificateSha256
    )
      throw new CutoverError("The final gateway schema or identity differs from the successful trial.");

    if (state.archiveSha256 && archiveSha256 !== state.archiveSha256)
      throw new CutoverError("The final archive has changed since the target accepted it.");

    if (state.phase === "restored") return state;

    await writeCutoverFile(this.#pendingKey, key);
    const accepted = await this.#save({ ...state, archiveSha256 });
    await importBundle(env, directory, { runId: this.#runId, stagingDirectory: directory });

    return this.#confirmedRestore(accepted);
  }

  async #bindDevice(state: CutoverTargetState, requested?: DesktopCutoverDevice) {
    const file = join(this.#host.stateDirectory, "move-desktop.json");
    const existing = await readCutoverFile(file, decodeDevice);

    if (!requested) return existing;

    if (!state.routes)
      throw new CutoverError("The target did not confirm pinned Network access routes for this Desktop.");

    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(requested))
        throw new CutoverError("A different Desktop was already authorized for this migration.");

      return existing;
    }

    if (state.phase !== "restored")
      throw new CutoverError("The destination has already started activation without this Desktop.");

    await writeCutoverFile(file, JSON.stringify(requested));

    return requested;
  }

  async #activate(state: CutoverTargetState, archiveSha256: string, desktop?: DesktopCutoverDevice) {
    if (state.archiveSha256 !== archiveSha256 || !["restored", "activating", "active"].includes(state.phase))
      throw new CutoverError("A verified final restore is required before activating the destination.");

    const device = await this.#bindDevice(state, desktop);

    if (state.phase === "active") {
      await rm(this.#pendingKey, { force: true });

      return state;
    }

    const fence = await readFence(this.#host.env);

    if (
      (fence && (fence.operationId !== this.#runId || fence.state !== "drained")) ||
      (!fence && state.phase === "restored")
    )
      throw new CutoverError("The destination database does not have the expected migration fence.");

    const activating = await this.#save({ ...state, phase: "activating" });
    const key = await this.#readKey();

    if (fence) {
      await this.#requireStopped();
      // Validate the destination connection and key together before clearing its runtime fence.
      await inspectDatabase({ ...this.#host.env, CANOPY_SECRETS_KEY: key });
      await provisionDestination(this.#host.env);

      if (device) await installDesktopDevice(this.#host, device);
    }

    await installTargetKey(this.#host, key);

    if (fence) await clearImportedFence(this.#host.env, this.#runId);

    const service = cutoverService(this.#host, { CANOPY_SECRETS_KEY: key });

    if (!(await service.ready())) await service.start();
    await waitForCutoverService(service, "Destination activation is pending. Retry or check the target service.");

    if (state.routes) await verifyCutoverRoutes(this.#host, state.routes);
    const active = await this.#save({ ...activating, phase: "active" });
    await rm(this.#pendingKey, { force: true });

    return active;
  }

  async #abort(state: CutoverTargetState) {
    if (state.phase === "activating" || state.phase === "active")
      throw new CutoverError("Destination activation has begun. Reconcile the migration before taking further action.");
    const aborted = await this.#save({ ...state, phase: "aborted" });
    await Promise.all([
      rm(this.#pendingKey, { force: true }),
      rm(join(this.#host.stateDirectory, "incoming"), { recursive: true, force: true }),
    ]);

    return aborted;
  }

  async run(request: MoveRequest, input: CutoverInput) {
    const state = await this.#confirmedRestore(await this.#state());

    switch (request.action) {
      case "prepare":
        return this.#prepare(state, request);
      case "trial":
      case "import":
        return this.#upload(state, request, input);
      case "activate":
        return this.#activate(state, request.archiveSha256, request.desktopDevice);
      case "abort":
        return this.#abort(state);
      case "status":
        return state;
    }
  }
}

function elapsed(started: number) {
  return Math.round(performance.now() - started);
}

async function provisionDestination(env: NodeJS.ProcessEnv) {
  if (!env["CANOPY_DATABASE_RUNTIME_URL"] && !env["CANOPY_DATABASE_RUNTIME_PASSWORD_FILE"]) return;
  const args = [process.execPath, ...(isStandalone() ? [] : [Bun.main]), "migrate"];
  const code = await Bun.spawn(args, { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;

  if (code !== 0) throw new CutoverError("Could not provision the destination database runtime credentials.");
}
