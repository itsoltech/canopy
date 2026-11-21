/** Local server-to-server cutover. Run from the repo root with CANOPY_LIVE=1 bun run check:tmp and this file. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { tempDirs } from "@canopy/testing";
import { pinnedCertificate } from "@canopy/transport";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually } from "./support/gateway.ts";
import {
  attachmentData,
  connectWorker,
  drainAnswer,
  drainMessage,
  pairedClient,
  rpcError,
  seedSource,
  verifyHistory,
} from "./support/gateway-relocation-data.ts";
import {
  createRelocationSandbox,
  privateFile,
  relocationAvailable,
  type RelocationHost,
} from "./support/gateway-relocation.ts";

const tempDir = tempDirs();

async function assertStartupFenced(host: RelocationHost, key: string) {
  const attempted = await host.command([], { CANOPY_SECRETS_KEY: key });
  expect(attempted.code).toBe(1);
  expect(attempted.stderr).toContain("Gateway startup blocked by a relocation fence");
  expect(await host.ready()).toBe(false);
}

async function assertTrialLeftTargetEmpty(target: RelocationHost) {
  const db = ManagedRuntime.make(target.db.layer);

  try {
    const tables = await db.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ present: boolean }>`SELECT to_regclass('public.threads') IS NOT NULL AS present`,
      ),
    );

    expect(tables).toEqual([{ present: false }]);
    expect(target.starts).toBe(0);
  } finally {
    await db.dispose();
  }
}

test.skipIf(!relocationAvailable)(
  "server cutover recovers lost SSH replies before commit and after activation",
  async () => {
    const sandbox = await createRelocationSandbox(tempDir("canopy-cutover-"));
    const clients = new AbortController();
    const key = randomBytes(32).toString("base64");

    try {
      const source = await sandbox.host("source", { migrated: true, secretsKey: key });
      const target = await sandbox.host("target");
      const ssh = await sandbox.ssh(target);
      const configPath = join(source.directory, "source.json");
      await privateFile(configPath, JSON.stringify({ ...source.config, target: ssh.config, drainTimeoutSeconds: 15 }));

      const cutover = (operation: string) =>
        source.command(["migration", "cutover", operation, "--config", configPath]);

      const status = async () => {
        const result = await cutover("status");
        expect(result).toMatchObject({ code: 0, stderr: "" });

        return JSON.parse(result.stdout);
      };

      await source.start();
      const seed = await seedSource(source, clients.signal);
      const { active, revoked, revokedAt, profile, trust, threadId, worker } = seed;
      const trial = await cutover("start");
      expect(trial).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(trial.stdout)).toMatchObject({
        phase: "trialed",
        trial: {
          certificateSha256: trust.fingerprint,
          sample: { threads: 1, workers: 1, devices: 2, attachments: 1 },
        },
      });
      await assertTrialLeftTargetEmpty(target);
      expect(source.stopped()).toBe(false);

      // The final snapshot must contain work that finished after the trial, even while new RPCs are rejected.
      worker.holdTurns = true;
      const sent = await source.api.sendMessage({ threadId, text: drainMessage, clientRequestId: "drain-turn" });

      const held = await eventually(
        () => source.api.getThread({ threadId }),
        (result) => result.thread?.status === "running",
      );

      expect(held.thread?.status).toBe("running");
      const drainTurnId = sent.turn!.id;
      await ssh.dropReply("restored");
      const interruptedBeforeCommit = cutover("resume");

      const denied = await eventually(
        () => rpcError(source.api.getThread({ threadId })),
        (error) => error?.code === Code.Unavailable && error.rawMessage.includes("maintenance"),
      );

      expect(denied).toMatchObject({ code: Code.Unavailable, rawMessage: "Gateway maintenance is in progress" });
      expect(
        (
          await rpcError(
            source.api.sendMessage({ threadId, text: "Do not admit this turn", clientRequestId: "denied" }),
          )
        )?.code,
      ).toBe(Code.Unavailable);
      expect(source.stopped()).toBe(false);
      expect(target.starts).toBe(0);
      worker.finish(threadId, drainTurnId, drainAnswer);
      expect(await interruptedBeforeCommit).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SSH cutover request failed"),
      });
      expect(await ssh.droppedReply("restored")).toBe(true);
      expect(await status()).toMatchObject({ phase: "exported", fence: "drained", targetPhase: "restored" });
      await worker.link.closed;
      await assertStartupFenced(source, key);
      await assertStartupFenced(target, key);

      await ssh.dropReply("active");
      expect(await cutover("resume")).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SSH cutover request failed"),
      });
      expect(await ssh.droppedReply("active")).toBe(true);
      expect(await status()).toMatchObject({ phase: "committed", fence: "committed", targetPhase: "active" });
      await assertStartupFenced(source, key);
      expect(await cutover("abort")).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("permanently committed"),
      });
      expect(target.starts).toBe(1);
      expect(await pinnedCertificate(target.networkUrl, trust.fingerprint)).toBe(trust.ca);

      const api = pairedClient(target, trust, active.deviceToken);
      const devices = await api.getMobileDevices({});
      expect(devices.devices.find((device) => device.id === revoked.device!.id)?.revokedAt).toEqual(revokedAt);
      expect((await rpcError(pairedClient(target, trust, revoked.deviceToken).getOverview({})))?.code).toBe(
        Code.Unauthenticated,
      );
      const attachment = await api.getAttachment({ attachmentId: seed.attachment.id });
      expect(attachment.attachment?.name).toBe("receipt.txt");
      expect(attachment.data).toEqual(attachmentData);
      const history = await verifyHistory(api, threadId, [seed.originalAnswer, drainAnswer]);
      expect(history.turns.map(({ id }) => id)).toEqual([seed.originalTurnId, drainTurnId]);
      expect(history.turns[0]?.attachments.map(({ id }) => id)).toEqual([seed.attachment.id]);
      expect(history.thread?.workerId).toBe(profile.worker_id);

      // ThreadReady plus three journal events per completed turn.
      const targetLink = await connectWorker(target, profile, trust, {
        signal: clients.signal,
        threads: [{ threadId, lastSeq: 7n }],
      });

      expect(targetLink.welcome.persisted).toContainEqual(expect.objectContaining({ threadId, lastSeq: 7n }));
      targetLink.close();
      await targetLink.closed;
      const written = await api.createProject({ name: "Written before source reconciled activation" });

      const resumed = await cutover("resume");
      expect(resumed).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(resumed.stdout)).toMatchObject({ phase: "active" });
      const repeated = await cutover("resume");
      expect(repeated).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(repeated.stdout)).toMatchObject({ phase: "active", runId: JSON.parse(resumed.stdout).runId });

      expect(await status()).toMatchObject({ phase: "active", fence: "committed", targetPhase: "active" });
      expect(target.starts).toBe(1);
      expect((await api.getOverview({})).projects.filter(({ id }) => id === written.project!.id)).toHaveLength(1);
    } finally {
      clients.abort();
      await sandbox.close();
    }
  },
  100_000,
);

test.skipIf(!relocationAvailable)(
  "aborting a restored cutover restarts the source and keeps the destination fenced",
  async () => {
    const sandbox = await createRelocationSandbox(tempDir("canopy-cutover-abort-"));
    const key = randomBytes(32).toString("base64");

    try {
      const source = await sandbox.host("source", { migrated: true, secretsKey: key });
      const target = await sandbox.host("target");
      const ssh = await sandbox.ssh(target);
      const configPath = join(source.directory, "source.json");
      await privateFile(configPath, JSON.stringify({ ...source.config, target: ssh.config, drainTimeoutSeconds: 15 }));

      const cutover = (operation: string) =>
        source.command(["migration", "cutover", operation, "--config", configPath]);

      await source.start();
      const original = await source.api.createProject({ name: "Keep this source" });
      expect(await cutover("start")).toMatchObject({ code: 0, stderr: "" });
      await ssh.dropReply("restored");
      expect(await cutover("resume")).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SSH cutover request failed"),
      });
      expect(await ssh.droppedReply("restored")).toBe(true);
      expect(source.stopped()).toBe(true);

      const aborted = await cutover("abort");
      expect(aborted).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(aborted.stdout)).toMatchObject({ phase: "aborted", targetCleanupPending: false });
      expect(await source.ready()).toBe(true);
      expect((await source.api.getOverview({})).projects).toContainEqual(
        expect.objectContaining({ id: original.project!.id }),
      );
      await assertStartupFenced(target, key);
      expect(target.starts).toBe(0);

      const repeated = await cutover("resume");
      expect(repeated).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(repeated.stdout)).toMatchObject({ phase: "aborted", targetCleanupPending: false });
      expect(source.starts).toBe(2);
    } finally {
      await sandbox.close();
    }
  },
  60_000,
);
