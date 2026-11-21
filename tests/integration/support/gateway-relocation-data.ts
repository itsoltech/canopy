import { expect } from "bun:test";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { Provider, ui } from "@canopy/contracts";
import { createGrpcClientTransport } from "@canopy/transport";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { enrollWorker } from "../../../apps/worker/src/enroll.ts";
import { SCRIPTED_ATTACHMENTS_ROOT, ScriptedWorker, eventually, watchUntil } from "./gateway.ts";
import type { RelocationHost } from "./gateway-relocation.ts";

export const attachmentData = new TextEncoder().encode("Receipt carried to the new gateway.\n");
export const originalMessage = "Store the original history";
export const drainMessage = "Finish this turn before the cutover";
export const drainAnswer = "The source finished its last turn";
const journalId = "gateway-relocation-journal";

type WorkerProfile = Awaited<ReturnType<typeof enrollWorker>>;

type Trust = { ca: string; fingerprint: string };

function pinned(host: RelocationHost, trust: Trust, token?: string) {
  return createGrpcClientTransport({
    baseUrl: host.networkUrl,
    ...trust,
    defaultTimeoutMs: 3_000,
    interceptors: token
      ? [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${token}`);

            return next(request);
          },
        ]
      : [],
  });
}

export function pairedClient(host: RelocationHost, trust: Trust, token: string) {
  return createClient(ui.GatewayService, pinned(host, trust, token));
}

export function rpcError<A>(call: Promise<A>) {
  return call.then(
    () => undefined,
    (cause) => ConnectError.from(cause),
  );
}

async function pair(host: RelocationHost, trust: Trust, name: string) {
  const pairing = createClient(ui.MobilePairingService, pinned(host, trust));
  const { code } = await host.api.createMobilePairing({});

  return pairing.exchangeMobilePairing({ code, name, platform: "ios" });
}

export function connectWorker(
  host: RelocationHost,
  profile: WorkerProfile,
  trust: Trust,
  options?: {
    signal?: AbortSignal;
    threads?: { threadId: string; lastSeq: bigint }[];
  },
) {
  return openGatewayLink({
    baseUrl: host.networkUrl,
    ...trust,
    signal: options?.signal ?? AbortSignal.timeout(90_000),
    credential: profile.credential,
    hello: {
      workerId: profile.worker_id,
      journalId,
      attachmentsRoot: SCRIPTED_ATTACHMENTS_ROOT,
      threads: options?.threads ?? [],
    },
  });
}

async function history(api: RelocationHost["api"], threadId: string) {
  const updates = await watchUntil(api, threadId, (frames) => frames.some((frame) => frame.change.case === "snapshot"));
  const change = updates.find((frame) => frame.change.case === "snapshot")?.change;

  if (change?.case !== "snapshot") throw new Error("The gateway did not return the thread snapshot");

  return change.value;
}

export async function verifyHistory(api: RelocationHost["api"], threadId: string, completed: string[]) {
  const snapshot = await history(api, threadId);
  const { items, turns } = snapshot;
  const answers = items.flatMap(({ item }) => (item?.content.case === "agentMessage" ? [item.content.value.text] : []));
  expect(answers).toEqual(completed);
  expect(turns.map(({ status }) => status)).toEqual(completed.map(() => "completed"));

  return snapshot;
}

export async function seedSource(host: RelocationHost, signal: AbortSignal) {
  const { api } = host;
  const network = await api.updateNetworkAccess({ action: "set_enabled", enabled: true });
  expect(network.state).toBe("on");
  const invitation = await api.createWorkerEnrollment({ name: "Originally enrolled worker" });

  const profile = await enrollWorker({
    gateway: host.networkUrl,
    fingerprint: network.fingerprint,
    token: invitation.token,
    configPath: join(host.directory, "worker.json"),
  });

  if (!profile.gateway_certificate || !profile.gateway_fingerprint)
    throw new Error("Worker enrollment lost the TLS pin");
  const trust = { ca: profile.gateway_certificate, fingerprint: profile.gateway_fingerprint };
  const worker = new ScriptedWorker(await connectWorker(host, profile, trust, { signal }));
  const [active, revoked] = await Promise.all([pair(host, trust, "Active phone"), pair(host, trust, "Revoked phone")]);
  const revokedId = revoked.device!.id;
  await api.revokeMobileDevice({ id: revokedId });
  const deleted = (await api.getMobileDevices({})).devices.find((device) => device.id === revokedId);
  expect(deleted?.revokedAt).toBeDefined();
  expect((await rpcError(pairedClient(host, trust, revoked.deviceToken).getOverview({})))?.code).toBe(
    Code.Unauthenticated,
  );

  const applied = await eventually(
    () => api.listModels({}),
    (models) => models.workers.some((entry) => entry.workerId === profile.worker_id && entry.configVersion > 0n),
  );

  expect(applied.workers.some((entry) => entry.workerId === profile.worker_id && entry.configVersion > 0n)).toBe(true);
  const { project } = await api.createProject({ name: "Moved project" });

  const { workspace } = await api.createWorkspace({
    workerId: profile.worker_id,
    rootPath: host.directory,
    projectId: project!.id,
    label: "Moved checkout",
  });

  const { attachment } = await api.uploadAttachment({ name: "receipt.txt", data: attachmentData });

  const { thread } = await api.createThread({
    projectId: project!.id,
    workspaceId: workspace!.id,
    provider: Provider.CODEX,
    title: "History from source",
    initialMessage: originalMessage,
    initialAttachmentIds: [attachment!.id],
  });

  const threadId = thread!.id;

  const original = await eventually(
    () => history(api, threadId),
    (snapshot) => snapshot.turns[0]?.status === "completed",
  );

  expect(original.turns[0]?.status).toBe("completed");
  const input = worker.inputs.get(threadId)?.[0];
  expect(input).toEndWith(originalMessage);
  const originalAnswer = `Echo: ${input}`;
  await verifyHistory(api, threadId, [originalAnswer]);
  expect([...worker.attachments.values()].flat().map((file) => file.attachmentId)).toContain(attachment!.id);

  return {
    worker,
    profile,
    trust,
    threadId,
    active,
    revoked,
    revokedAt: deleted!.revokedAt,
    attachment: attachment!,
    originalAnswer,
    originalTurnId: original.turns[0]!.id,
  };
}
