import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { SqlClient } from "effect/sql";
import { parseObject, str } from "@canopy/domain/json";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const tempDir = tempDirs();

describe.skipIf(!dockerAvailable)("paired phone thread secrets", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let projectId = "";
  let workspaceId = "";
  const transport = nodePinnedTransport();

  const phone = (token?: string) =>
    routedMobileClient({ connection: gw.core.mobile.networkRoutes(), transport, ...(token && { token }) });

  const query = <A extends object>(statement: string, ...params: string[]) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, params)));

  async function pair() {
    const invitation = await gw.api.createMobilePairing({});

    return phone().pairing.exchangeMobilePairing({ code: invitation.code, name: "Secret phone", platform: "ios" });
  }

  async function request() {
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, initialMessage: "Work" })
    ).thread!;

    const turns = await eventually(
      () => query<{ id: string; status: string }>("SELECT id,status FROM turns WHERE thread_id=$1::uuid", thread.id),
      (rows) => rows.some((t) => t.status === "running"),
    );

    const turnId = turns.find((t) => t.status === "running")!.id;
    const requestId = Bun.randomUUIDv7();

    const waiting = gw.worker.callTool({
      threadId: thread.id,
      turnId,
      callId: requestId,
      tool: "request_secret",
      args: {
        label: "Development token",
        description: "Access the development account.",
        name: "DEVELOPMENT_TOKEN",
      },
    });

    await eventually(
      () => query("SELECT id FROM thread_secrets WHERE id=$1::uuid", requestId),
      (rows) => rows.length === 1,
    );

    return { threadId: thread.id, turnId, requestId, waiting };
  }

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { secretsDataDir: tempDir("canopy-phone-secrets-") } });
    gw.worker.holdTurns = true;
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    projectId = (await gw.api.createProject({ name: "Phone secrets" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  test("save, expiry metadata, decline and revoke use the paired transport without returning values", async () => {
    const api = phone((await pair()).deviceToken).api;
    const source = await request();
    const updates = await watchUntil(api, source.threadId, (u) => u.some((v) => v.change.case === "snapshot"));
    const snapshot = updates[0]?.change;
    expect(
      snapshot?.case === "snapshot" &&
        snapshot.value.secrets.some((s) => s.requestId === source.requestId && s.status === "pending"),
    ).toBe(true);
    const value = crypto.randomUUID();
    const saved = await api.answerThreadSecret({ requestId: source.requestId, value });
    expect(saved.secret?.status).toBe("saved");
    expect(Number(saved.secret?.expiresAt?.seconds) * 1000 - Date.now()).toBeGreaterThan(86_000_000);
    expect(toJsonString(ui.ThreadSecretResponseSchema, saved).includes(value)).toBe(false);
    const result = await source.waiting;
    expect(result.content.includes(value)).toBe(false);
    const file = str(parseObject(result.content)["file"]);
    expect(existsSync(file)).toBe(true);
    const after = await watchUntil(api, source.threadId, (u) => u.some((v) => v.change.case === "snapshot"));
    expect(after.some((u) => toJsonString(ui.ThreadUpdateSchema, u).includes(value))).toBe(false);
    expect((await api.revokeThreadSecret({ requestId: source.requestId })).secret?.status).toBe("revoked");
    await eventually(
      () => Promise.resolve(existsSync(file)),
      (present) => !present,
    );
    const declined = await request();
    expect((await api.answerThreadSecret({ requestId: declined.requestId, decline: true })).secret?.status).toBe(
      "declined",
    );
    expect(str(parseObject((await declined.waiting).content)["file"])).toBe("");
    gw.worker.finish(source.threadId, source.turnId);
    gw.worker.finish(declined.threadId, declined.turnId);
  });

  test("a different owner and a revoked phone cannot read, answer or revoke a request", async () => {
    const paired = await pair();
    const api = phone(paired.deviceToken).api;
    const source = await request();
    const otherOwner = crypto.randomUUID();
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')",
      otherOwner,
      `${otherOwner}@example.test`,
    );
    const foreignThread = crypto.randomUUID();
    const foreignRequest = crypto.randomUUID();
    await query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status)
      SELECT $1::uuid,$1::uuid,$2::uuid,project_id,'main',runtime,provider,worker_id,workspace_id,cwd,'idle' FROM threads WHERE id=$3::uuid`,
      foreignThread,
      otherOwner,
      source.threadId,
    );
    await query(
      `INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description)
      SELECT $1::uuid,$2::uuid,turn_id,$1::uuid,label,description FROM thread_secrets WHERE id=$3::uuid`,
      foreignRequest,
      foreignThread,
      source.requestId,
    );
    await expect(
      api.answerThreadSecret({ requestId: foreignRequest, value: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(api.revokeThreadSecret({ requestId: foreignRequest })).rejects.toMatchObject({ code: Code.NotFound });

    const denied = async () => {
      for await (const update of api.watchThread({ threadId: foreignThread }, { signal: AbortSignal.timeout(3000) }))
        return update;
      throw new Error("Thread stream ended without a snapshot");
    };

    await expect(denied()).rejects.toBeDefined();
    expect(await query("SELECT status,ciphertext FROM thread_secrets WHERE id=$1::uuid", foreignRequest)).toEqual([
      { status: "pending", ciphertext: null },
    ]);
    const foreignPhone = await pair();
    await query(
      "UPDATE mobile_devices SET owner_user_id=$1::uuid WHERE id=$2::uuid",
      otherOwner,
      foreignPhone.device!.id,
    );
    await expect(
      phone(foreignPhone.deviceToken).api.answerThreadSecret({ requestId: source.requestId, decline: true }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    await expect(
      api.answerThreadSecret({ requestId: source.requestId, value: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(api.revokeThreadSecret({ requestId: source.requestId })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(await query("SELECT status,ciphertext FROM thread_secrets WHERE id=$1::uuid", source.requestId)).toEqual([
      { status: "pending", ciphertext: null },
    ]);
    const independent = phone((await pair()).deviceToken).api;
    await independent.answerThreadSecret({ requestId: source.requestId, decline: true });
    await source.waiting;
    gw.worker.finish(source.threadId, source.turnId);
  });
});
