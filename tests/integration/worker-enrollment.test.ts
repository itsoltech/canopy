import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { toJsonString } from "@bufbuild/protobuf";
import { ui, WorkerEnrollmentService } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { WorkerAdministration } from "../../apps/gateway/src/core/worker-administration.ts";
import { loadLocalConfig } from "../../apps/worker/src/config/local.ts";
import { Result } from "effect";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
const dir = mkdtempSync(join(tmpdir(), "canopy-enrollment-"));
const host = { hostname: "second-machine", os: "linux", arch: "x64" };
let client: ReturnType<typeof createClient<typeof WorkerEnrollmentService>>;
async function query(statement: string, params: unknown[]) {
  return gw.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; return yield* sql.unsafe<Record<string, unknown>>(statement, params); }));
}

describe.skipIf(!dockerAvailable)("worker enrollment and credential lifecycle over gRPC", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    client = createClient(WorkerEnrollmentService, createGrpcTransport({ baseUrl: gw.grpcUrl }));
  }, 60_000);
  afterAll(async () => { await gw?.close(); rmSync(dir, { recursive: true, force: true }); });

  test("CLI spends a token once, writes a private config, connects; rotation and revoke invalidate the live link", async () => {
    const invitation = await gw.api.createWorkerEnrollment({ name: "Second machine" });
    const configPath = join(dir, "second", "worker.json");
    const dataDir = join(dir, "data");
    const cli = Bun.spawn([process.execPath, resolve("apps/worker/src/main.ts"), "enroll", "--gateway", gw.grpcUrl, "--token", invitation.token, "--config", configPath, "--data-dir", dataDir], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const loaded = await loadLocalConfig(configPath, process.platform);
    if (Result.isFailure(loaded)) throw new Error(loaded.failure);
    const config = loaded.success;
    expect(config.data_dir).toBe(dataDir);
    expect(stdout).not.toContain(invitation.token);
    expect(stdout).not.toContain(config.credential);
    expect(await failure(client.enroll({ enrollmentToken: invitation.token, host }))).toContain("already used");
    expect(await gw.runtime.runPromise(GatewayStore.use((s) => s.authenticateWorker(config.credential)))).toBe(config.worker_id);
    const worker = await gw.connect(config.worker_id, config.credential, "linux");
    expect((await eventually(() => gw.api.getOverview({}), (o) => o.workers.some((w) => w.id === config.worker_id && w.online))).workers.find((w) => w.id === config.worker_id)?.online).toBe(true);
    const configBefore = readFileSync(configPath, "utf8");
    const unused = await gw.api.createWorkerEnrollment({ name: "Keep existing file" });
    const duplicate = Bun.spawn([process.execPath, resolve("apps/worker/src/main.ts"), "enroll", "--gateway", gw.grpcUrl, "--token", unused.token, "--config", configPath], { stdout: "pipe", stderr: "pipe" });
    expect(await duplicate.exited).toBe(78);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect((await gw.api.getWorkerSetup({})).enrollments.find((e) => e.id === unused.enrollment!.id)?.usedAt).toBeUndefined();

    const rotated = await gw.api.rotateWorkerCredential({ workerId: config.worker_id });
    expect(worker.link.closed).toBeDefined();
    expect(gw.core.link.connections.has(config.worker_id)).toBe(false);
    expect(await failure(gw.connect(config.worker_id, config.credential))).toContain("invalid worker credential");
    await gw.connect(config.worker_id, rotated.credential, "linux");
    await gw.api.revokeWorker({ workerId: config.worker_id });
    expect(gw.core.link.connections.has(config.worker_id)).toBe(false);
    expect(await failure(gw.connect(config.worker_id, rotated.credential))).toContain("invalid worker credential");
    const revoked = (await gw.api.getOverview({})).workers.find((w) => w.id === config.worker_id)!;
    expect(revoked.online).toBe(false);
    expect(revoked.revokedAt).toBeDefined();
    await gw.api.archiveWorker({ workerId: config.worker_id });
    expect((await gw.api.getOverview({})).workers.some((w) => w.id === config.worker_id)).toBe(false);
  }, 30_000);

  test("concurrent exchange has one winner; expired/revoked tokens and other owners cannot mutate enrollment or workers", async () => {
    const invitation = await gw.api.createWorkerEnrollment({ name: "Race" });
    const results = await Promise.allSettled([client.enroll({ enrollmentToken: invitation.token, host }), client.enroll({ enrollmentToken: invitation.token, host })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("no winner");
    const expired = await gw.api.createWorkerEnrollment({ name: "Expired" });
    await query("UPDATE worker_enrollments SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [expired.enrollment!.id]);
    expect(await failure(client.enroll({ enrollmentToken: expired.token, host }))).toContain("expired");
    const revoked = await gw.api.createWorkerEnrollment({ name: "Revoked" });
    await gw.api.revokeWorkerEnrollment({ id: revoked.enrollment!.id });
    expect(await failure(client.enroll({ enrollmentToken: revoked.token, host }))).toContain("revoked");
    const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
    const other = new WorkerAdministration({ runtime: gw.runtime, userId: otherUser, link: gw.core.link, publish: () => {}, removed: () => {}, changed: async () => {} });
    expect((await other.setup()).enrollments).toHaveLength(0);
    expect(await failure(other.revokeEnrollment(invitation.enrollment!.id))).toContain("not found");
    for (const action of ["rename", "rotate", "revoke", "archive"] as const) expect(await failure(other.manage(winner.value.workerId, action, "Stolen"))).toContain("not found");
    // Public exchange has no owner parameter: possession authorizes enrollment only for the bound owner.
    const ownership = await query("SELECT owner_user_id FROM workers WHERE id = $1", [winner.value.workerId]);
    expect(ownership[0]?.["owner_user_id"]).toBe(gw.userId);
    const setup = toJsonString(ui.GetWorkerSetupResponseSchema, await gw.api.getWorkerSetup({}));
    expect(setup).not.toContain(invitation.token);
    expect(setup).not.toContain(winner.value.workerCredential);
  });

  test("errors never echo secrets and the anonymous endpoint has a bounded attempt budget", async () => {
    const token = "a".repeat(43);
    for (let i = 0; i < 65; i++) {
      const error = await failure(client.enroll({ enrollmentToken: token, host }));
      expect(error).not.toContain(token);
      if (i === 64) expect(error).toContain("Too many enrollment attempts");
    }
  });
});
