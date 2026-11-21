import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { databaseUrl } from "../database-credentials.ts";
import { loadSecretsKey } from "../store/secrets.ts";
import { parseApprovedSecrets } from "./consolidation-approved.ts";
import { importConsolidation, inspectConsolidation, readConsolidationReceipt } from "./consolidation-import.ts";
import { materializeConsolidationProjection } from "./consolidation-projection.ts";
import type { ApprovedConsolidationSecret, ConsolidationInput, ConsolidationReceipt } from "./consolidation-types.ts";
import {
  joinArchive,
  joinStateDirectory,
  readJoinState,
  summarizeJoin,
  writeJoinState,
  type JoinCandidate,
  type JoinState,
} from "./consolidation-target-state.ts";
import { CutoverError, readCutoverFile, withCutoverLock } from "./cutover-files.ts";
import { installDesktopDevice, readCutoverRoutes } from "./cutover-desktop.ts";
import {
  cutoverService,
  loadCutoverHost,
  recoverCutoverService,
  targetConfigPath,
  type CutoverHost,
} from "./cutover-host.ts";
import type { CutoverInput, DesktopCutoverDevice, JoinRequest } from "./cutover-protocol.ts";
import { readMigrationOwner, requireOfflineSource, withTrialDatabase } from "./postgres.ts";
import { abortFence, readFence, requestDrain } from "./relocation-fence.ts";

type PrepareRequest = Extract<JoinRequest, { action: "join-prepare" }>;

type ApplyRequest = Extract<JoinRequest, { action: "join-import" }>;

type ReviewRequest = Extract<JoinRequest, { action: "join-review" }>;

type ReviewedState = Extract<JoinState, { phase: "reviewed" | "applying" }>;

interface JoinTarget {
  host: CutoverHost;
  directory: string;
  runId: string;
}

export async function joinTarget(request: JoinRequest, input: CutoverInput, env: NodeJS.ProcessEnv): Promise<object> {
  const configured = await loadCutoverHost(env["CANOPY_MIGRATION_JOIN_CONFIG"] ?? targetConfigPath(env), env);
  const saved = await readCutoverFile(configured.secretFile, parseEnv);
  const key = saved?.["CANOPY_SECRETS_KEY"] ?? configured.env["CANOPY_SECRETS_KEY"];
  const host = { ...configured, env: { ...configured.env, CANOPY_SECRETS_KEY: key } };

  return withCutoverLock(host.stateDirectory, async () => {
    const directory = await joinStateDirectory(host.stateDirectory, request.runId);
    const state = await readJoinState(directory);
    const target = { host, directory, runId: request.runId };

    if (request.action === "join-prepare") return prepare(target, input, request, state);

    if (request.action === "join-import") {
      const secrets = parseApprovedSecrets(await input.secretPayload(request.secretBytes));

      return apply(target, request, state, secrets);
    }

    await input.end();

    if (request.action === "join-review") return refreshReview(target, request, state);

    if (request.action === "join-abort") {
      if (state?.phase === "applied" || state?.phase === "applying")
        throw new CutoverError("This consolidation was committed. Resume it from the source Desktop.");

      await writeJoinState(directory, { phase: "aborted" });

      if (state?.phase === "reviewed") await removeCandidate(directory, state.candidate);

      return summarizeJoin(target.runId, { phase: "aborted" });
    }

    return respond(target, state);
  });
}

async function respond(target: JoinTarget, state: JoinState | undefined) {
  const status = summarizeJoin(target.runId, state);

  if (!state || state.phase === "aborted") return status;

  const routes = await readCutoverRoutes(target.host);

  return { ...status, ...(routes && { routes }) };
}

function removeCandidate(directory: string, source: JoinCandidate) {
  return rm(joinArchive(directory, source), { recursive: true, force: true });
}

async function targetIdentity(host: CutoverHost): Promise<ConsolidationInput["target"]> {
  const ownerUserId = await readMigrationOwner(host.env);
  const secretsKey = loadSecretsKey(host.env);

  return { ownerUserId, secretsKey };
}

async function withStagedSource<T>(
  target: JoinTarget,
  candidate: JoinCandidate,
  use: (input: ConsolidationInput, fence: "drained" | null) => Promise<T>,
) {
  const { host, directory, runId } = target;
  const archive = joinArchive(directory, candidate);
  const central = await targetIdentity(host);

  return withTrialDatabase(host.env, runId, async (trialEnv) => {
    const targetDatabaseUrl = databaseUrl(host.env);

    const restored = await materializeConsolidationProjection(trialEnv, archive, {
      targetDatabaseUrl,
      operationId: runId,
    });

    const context: ConsolidationInput = {
      operationId: runId,
      archiveSha256: restored.archiveSha256,
      sourceDatabaseUrl: databaseUrl(trialEnv),
      targetDatabaseUrl,
      source: {
        nodeId: restored.source.nodeId,
        ownerUserId: restored.source.ownerUserId,
      },
      target: central,
    };

    return use(context, restored.fence);
  });
}

async function prepare(target: JoinTarget, input: CutoverInput, request: PrepareRequest, state: JoinState | undefined) {
  if (state && state.phase !== "reviewed")
    throw new CutoverError("This consolidation can no longer replace its archive.");

  const { directory } = target;
  const candidate = { directoryId: randomUUID() };

  try {
    await input.receiveBundle(joinArchive(directory, candidate), request);
    const review = await withStagedSource(target, candidate, (context) => inspectConsolidation(context));
    const prepared = { phase: "reviewed", review, candidate } as const;
    await writeJoinState(directory, prepared);

    if (state) await removeCandidate(directory, state.candidate).catch(() => {});

    return respond(target, prepared);
  } catch (error) {
    const current = await readJoinState(directory).catch(() => undefined);

    if (current?.phase !== "reviewed" || current.candidate.directoryId !== candidate.directoryId)
      await removeCandidate(directory, candidate).catch(() => {});

    throw error;
  }
}

async function drainTarget(target: JoinTarget) {
  const { host, runId } = target;
  await requestDrain(host.env, runId);
  const deadline = Date.now() + 30 * 60_000;

  while (Date.now() < deadline) {
    const state = await readFence(host.env);

    if (state?.operationId !== runId) throw new CutoverError("The target gateway is fenced for another operation.");

    if (state.state === "drained") {
      const service = cutoverService(host);

      if (!(await service.stopped())) await service.stop();

      await requireOfflineSource(host.env);

      return;
    }

    await Bun.sleep(1000);
  }

  throw new CutoverError("The target did not finish its active work in time.");
}

async function resumeTarget(target: JoinTarget) {
  const { host, runId } = target;
  const state = await readFence(host.env);

  if (state && state.operationId !== runId)
    throw new CutoverError("The target gateway is fenced for another operation.");

  const { shuttingDown } = await abortFence(host.env, runId);
  await recoverCutoverService(
    cutoverService(host),
    shuttingDown,
    "The target gateway did not become ready. Resume after checking its service.",
  );
}

async function recordApplied(
  target: JoinTarget,
  state: ReviewedState,
  receipt: ConsolidationReceipt,
  device: DesktopCutoverDevice | undefined,
) {
  if (
    receipt.archiveSha256 !== state.review.archiveSha256 ||
    receipt.sourceNodeId !== state.review.sourceNodeId ||
    receipt.sourceOwnerUserId !== state.review.sourceOwnerUserId ||
    receipt.targetOwnerUserId !== state.review.targetOwnerUserId
  )
    throw new CutoverError("The consolidation receipt does not match the prepared source.");

  if (device) await installDesktopDevice(target.host, device);
  await resumeTarget(target);
  const applied = { phase: "applied", receipt } as const;
  await writeJoinState(target.directory, applied);
  await removeCandidate(target.directory, state.candidate).catch(() => {});

  return respond(target, applied);
}

async function findReceipt(target: JoinTarget) {
  return readConsolidationReceipt({
    operationId: target.runId,
    targetDatabaseUrl: databaseUrl(target.host.env),
    target: await targetIdentity(target.host),
  });
}

async function refreshReview(target: JoinTarget, request: ReviewRequest, state: JoinState | undefined) {
  if (state?.phase === "applied" && state.receipt.archiveSha256 === request.archiveSha256)
    return respond(target, state);

  if (
    (state?.phase !== "reviewed" && state?.phase !== "applying") ||
    state.review.archiveSha256 !== request.archiveSha256
  )
    throw new CutoverError("The consolidation review does not match the prepared archive.");

  const receipt = await findReceipt(target);

  if (receipt) return recordApplied(target, state, receipt, request.desktopDevice);

  return withStagedSource(target, state.candidate, async (context, fence) => {
    if (fence !== "drained" || context.archiveSha256 !== request.archiveSha256)
      throw new CutoverError("The final source archive must contain the matching drained gateway fence.");

    const targetFence = await readFence(target.host.env);

    if (targetFence?.operationId === target.runId) await resumeTarget(target);

    const review = await inspectConsolidation(context);
    const refreshed = { ...state, review };
    await writeJoinState(target.directory, refreshed);

    return respond(target, refreshed);
  });
}

async function apply(
  target: JoinTarget,
  request: ApplyRequest,
  state: JoinState | undefined,
  secrets: readonly ApprovedConsolidationSecret[],
) {
  if (state?.phase === "applied" && state.receipt.archiveSha256 === request.archiveSha256)
    return respond(target, state);

  if (
    (state?.phase !== "reviewed" && state?.phase !== "applying") ||
    state.review.archiveSha256 !== request.archiveSha256 ||
    state.review.reviewDigest !== request.approval.reviewDigest
  )
    throw new CutoverError("The consolidation request does not match the approved archive and review.");

  const pending = { ...state, phase: "applying" } as const;
  const receipt = await findReceipt(target);

  if (receipt) return recordApplied(target, pending, receipt, request.desktopDevice);

  return withStagedSource(target, state.candidate, async (context, fence) => {
    if (fence !== "drained" || context.archiveSha256 !== request.archiveSha256)
      throw new CutoverError("The final source archive must contain the matching drained gateway fence.");

    await writeJoinState(target.directory, pending);

    try {
      await drainTarget(target);
      const review = await inspectConsolidation(context);

      if (review.reviewDigest !== request.approval.reviewDigest) {
        const changed = { ...pending, review };
        await writeJoinState(target.directory, changed);
        await resumeTarget(target);

        return respond(target, changed);
      }

      const applied = await importConsolidation(context, request.approval, secrets);

      return await recordApplied(target, pending, applied, request.desktopDevice);
    } catch (error) {
      await resumeTarget(target);
      throw error;
    }
  });
}
