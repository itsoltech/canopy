import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@canopy/contracts";
import { ItemStatus, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { PROJECT_SECRET_LEASES } from "@canopy/domain";
import { Code } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

type Scope = { threadId: string; turnId: string };

type ReceiptEvent = Scope & { requestId: string; revision: number; remove: boolean; digest: bigint; cwd: string };

type LeaseResult = { request_id: string; status: string; file?: string; expires_at?: string };

const secretName = "SERVICE_PASSWORD";
const value = () => `synthetic-${crypto.randomUUID()}`;
const leaseResult = (result: AgentToolResult): LeaseResult => JSON.parse(result.content);

describe.skipIf(!dockerAvailable)("project secrets (gateway ↔ worker)", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const events: ReceiptEvent[] = [];
  const awaitingReceipt = new Set<string>();

  function workerOptions(path: string): ScriptedWorker["options"] {
    return {
      hello: { capabilities: [PROJECT_SECRET_LEASES, "running_turns"] },
      onSecretDelivery: ({ requestId, threadId, turnId, revision, remove, value, cwd }) => {
        events.push({ requestId, threadId, turnId, revision, remove, digest: Bun.hash(value), cwd });

        if (!remove && awaitingReceipt.has(requestId)) return undefined;

        return {
          requestId,
          threadId,
          turnId,
          revision,
          applied: true,
          file: remove ? "" : path,
        };
      },
    };
  }

  const query = <A extends object>(text: string, ...params: string[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }),
    );

  async function start(worker = gw.worker, project = projectId, workspace = workspaceId): Promise<Scope> {
    worker.holdTurns = true;

    const { thread } = await gw.api.createThread({
      projectId: project,
      workspaceId: workspace,
      provider: Provider.CODEX,
      title: "Project secrets",
      initialMessage: "work",
    });

    const threadId = thread!.id;

    const turns = await eventually(
      () => query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid AND status='running'", threadId),
      (rows) => rows.length === 1,
    );

    return { threadId, turnId: turns[0]!.id };
  }

  function request(source: Scope, options?: { worker?: ScriptedWorker; callId?: string; retryId?: string }) {
    return (options?.worker ?? gw.worker).callTool({
      ...source,
      ...(options?.callId && { callId: options.callId }),
      tool: "request_secret",
      args: { project_secret: secretName, ...(options?.retryId && { request_id: options.retryId }) },
    });
  }

  function removed(requestId: string) {
    return eventually(
      async () =>
        query<{ status: string }>(
          "SELECT status FROM project_secret_leases WHERE id=$1::uuid AND revision=applied_revision AND file_path IS NULL",
          requestId,
        ),
      (rows) => rows.length === 1,
    );
  }

  beforeAll(async () => {
    gw = await startTestGateway({ worker: workerOptions("/private/initial") });
    projectId = (await gw.api.createProject({ name: "Project secrets" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("stores encrypted, case-sensitive credentials and scopes write-only CRUD to its owner and project", async () => {
    const password = value();
    const put = await gw.api.putProjectSecret({ projectId, name: secretName, value: password });
    expect(put.secret).toMatchObject({ name: secretName, updatedAt: expect.any(Object) });
    expect(Object.keys(put.secret!)).not.toContain("value");
    await gw.api.putProjectSecret({ projectId, name: secretName.toLowerCase(), value: value() });
    const { secrets } = await gw.api.listProjectSecrets({ projectId });
    expect(secrets.map(({ name }) => name).sort()).toEqual([secretName, secretName.toLowerCase()]);

    const encrypted = await query<{ encrypted: boolean; key_id: string }>(
      `SELECT ciphertext <> convert_to($3, 'UTF8') AND position(convert_to($3, 'UTF8') in ciphertext)=0 AS encrypted,
        key_id FROM project_secrets WHERE project_id=$1::uuid AND name=$2`,
      projectId,
      secretName,
      password,
    );

    expect(encrypted).toEqual([{ encrypted: true, key_id: "env-v1" }]);
    await expect(gw.api.putProjectSecret({ projectId, name: "bad name", value: password })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(
      gw.api.putProjectSecret({ projectId, name: secretName, value: "ą".repeat(16385) }),
    ).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    const foreignOwner = Bun.randomUUIDv7();
    const foreignProject = Bun.randomUUIDv7();
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES ($1::uuid,$2,'Other user','user')",
      foreignOwner,
      `${foreignOwner}@example.test`,
    );
    await query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES ($1::uuid,$2::uuid,'Other project','other')",
      foreignProject,
      foreignOwner,
    );

    const [scratch] = await query<{ id: string }>(
      "SELECT id FROM projects WHERE owner_user_id=$1::uuid AND kind='scratch'",
      gw.userId,
    );

    for (const inaccessible of [foreignProject, scratch!.id]) {
      await expect(gw.api.listProjectSecrets({ projectId: inaccessible })).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(
        gw.api.putProjectSecret({ projectId: inaccessible, name: secretName, value: password }),
      ).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(gw.api.deleteProjectSecret({ projectId: inaccessible, name: secretName })).rejects.toMatchObject({
        code: Code.NotFound,
      });
    }

    await gw.api.deleteProjectSecret({ projectId, name: secretName.toLowerCase() });
    expect((await gw.api.listProjectSecrets({ projectId })).secrets.map(({ name }) => name)).toEqual([secretName]);
  });

  test("describes local project secret availability in CreateThread and refreshes it for existing threads", async () => {
    const project = (await gw.api.createProject({ name: "Secret capability" })).project!;

    const workspace = (
      await gw.api.createWorkspace({
        projectId: project.id,
        workerId: gw.workerId,
        rootPath: "/repo",
      })
    ).workspace!;

    const createFlag = (threadId: string) =>
      gw.worker.commands.flatMap((command) => {
        if (command.case !== "createThread") return [];
        const spec = command.value.profiledThread?.thread ?? command.value.thread;

        return spec?.threadId === threadId ? [spec.projectSecretsConfigured] : [];
      });

    const startFlag = (turnId: string) =>
      eventually(
        async () =>
          gw.worker.commands.flatMap((command) => {
            if (command.case !== "startTurn" || command.value.turnId !== turnId) return [];
            const spec = command.value.profiledThread?.thread ?? command.value.thread;

            return spec ? [spec.projectSecretsConfigured] : [];
          }),
        (flags) => flags.length > 0,
      );

    const first = await start(gw.worker, project.id, workspace.id);
    expect(createFlag(first.threadId)).toEqual([false]);
    expect(await startFlag(first.turnId)).toEqual([false]);
    await gw.api.putProjectSecret({ projectId: project.id, name: secretName, value: value() });
    const configured = await start(gw.worker, project.id, workspace.id);
    expect(createFlag(configured.threadId)).toEqual([true]);
    expect(await startFlag(configured.turnId)).toEqual([true]);
    gw.worker.finish(configured.threadId, configured.turnId);

    const scratch = (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!;
    const scratchWorkspace = scratch.workspaces.find((entry) => entry.workerId === gw.workerId)!;
    const unconfigured = await start(gw.worker, scratch.id, scratchWorkspace.id);
    expect(createFlag(unconfigured.threadId)).toEqual([false]);
    expect(await startFlag(unconfigured.turnId)).toEqual([false]);
    gw.worker.finish(unconfigured.threadId, unconfigured.turnId);

    gw.worker.finish(first.threadId, first.turnId);
    const { turn: next } = await gw.api.sendMessage({ threadId: first.threadId, text: "Use the configured project" });
    expect(await startFlag(next!.id)).toEqual([true]);
    await gw.api.deleteProjectSecret({ projectId: project.id, name: secretName });
    gw.worker.finish(first.threadId, next!.id);
    const { turn: last } = await gw.api.sendMessage({ threadId: first.threadId, text: "After removing configuration" });
    expect(await startFlag(last!.id)).toEqual([false]);
    gw.worker.finish(first.threadId, last!.id);
    await eventually(
      () => query("SELECT 1 FROM turns WHERE id=$1::uuid AND status='completed'", last!.id),
      (rows) => rows.length === 1,
    );
  }, 15_000);

  test("issues separate leases, revokes their revisions on rotation and deletion, and removes the file on turn end", async () => {
    const original = value();
    await gw.api.putProjectSecret({ projectId, name: secretName, value: original });
    const first = await start();
    const second = await start();
    expect(
      JSON.parse((await gw.worker.callTool({ ...first, tool: "list_project_secrets", args: {} })).content),
    ).toEqual({ names: [secretName] });
    const [a, b] = (await Promise.all([request(first), request(second)])).map(leaseResult);
    expect(a!.status).toBe("saved");
    expect(b!.status).toBe("saved");
    expect(a!.request_id === b!.request_id).toBe(false);
    expect(Date.parse(a!.expires_at!) - Date.now()).toBeLessThanOrEqual(900_000);
    expect(events).toContainEqual({
      ...first,
      requestId: a!.request_id,
      revision: 1,
      remove: false,
      digest: Bun.hash(original),
      cwd: "/repo",
    });
    expect(events).toContainEqual({
      ...second,
      requestId: b!.request_id,
      revision: 1,
      remove: false,
      digest: Bun.hash(original),
      cwd: "/repo",
    });
    expect((await request(second, { retryId: a!.request_id })).isError).toBe(true);
    const argumentsJson = JSON.stringify({ project_secret: secretName });

    const resultJson = JSON.stringify(a);

    const formats = [
      { case: "agentBusCall", value: { toolName: "request_secret", argumentsJson, resultJson } },
      {
        case: "toolCall",
        value: { server: "canopy", name: "request_secret", inputJson: argumentsJson, output: resultJson },
      },
    ] as const;

    for (const content of formats) {
      gw.worker.emit(
        first.threadId,
        first.turnId,
        {
          case: "itemCompleted",
          value: {
            item: {
              itemId: `${a!.request_id}-${content.case}`,
              status: ItemStatus.COMPLETED,
              content,
            },
          },
        },
        resultJson,
      );
    }

    const transcript = await eventually(
      () =>
        query<{ private_path: boolean }>(
          `SELECT position($3 in (i.content::text||e.payload::text||coalesce(e.raw::text,'')))>0 AS private_path
            FROM thread_items i JOIN thread_events e ON e.thread_id=i.thread_id AND e.item_id=i.item_id
            WHERE i.thread_id=$1::uuid AND i.item_id LIKE $2||'-%'`,
          first.threadId,
          a!.request_id,
          a!.file!,
        ),
      (rows) => rows.length === formats.length,
    );

    expect(transcript).toEqual([{ private_path: false }, { private_path: false }]);
    expect(
      await query(
        "SELECT position($2 in result::text)>0 AS private_path FROM agent_bus_calls WHERE id=$1::uuid",
        a!.request_id,
        a!.file!,
      ),
    ).toEqual([{ private_path: false }]);

    const replacement = value();
    await gw.api.putProjectSecret({ projectId, name: secretName, value: replacement });
    expect(await removed(a!.request_id)).toEqual([{ status: "revoked" }]);
    expect(await removed(b!.request_id)).toEqual([{ status: "revoked" }]);
    expect(leaseResult(await request(first, { callId: a!.request_id }))).toEqual({
      request_id: a!.request_id,
      status: "revoked",
    });
    const [snapshot] = await watchUntil(gw.api, first.threadId, (updates) => updates.length > 0);
    expect(snapshot?.change.case === "snapshot" && snapshot.change.value.secrets).toMatchObject([
      {
        projectSecret: secretName,
        requestId: a!.request_id,
        status: "revoked",
      },
    ]);
    const fresh = leaseResult(await request(first));
    expect(events).toContainEqual({
      ...first,
      requestId: fresh.request_id,
      revision: 1,
      remove: false,
      digest: Bun.hash(replacement),
      cwd: "/repo",
    });
    gw.worker.finish(first.threadId, first.turnId);
    expect(await removed(fresh.request_id)).toEqual([{ status: "expired" }]);

    const last = leaseResult(await request(second));
    await gw.api.deleteProjectSecret({ projectId, name: secretName });
    expect(await removed(last.request_id)).toEqual([{ status: "revoked" }]);
    expect((await request(second)).isError).toBe(true);
    gw.worker.finish(second.threadId, second.turnId);
  }, 20_000);

  test("fails before delivery on an older worker and stops waiting on an exact terminal rejection", async () => {
    await gw.api.putProjectSecret({ projectId, name: secretName, value: value() });
    const old = await gw.addWorker("Previous release");
    const oldFrames: ReceiptEvent[] = [];

    const legacy = await gw.connect(old.workerId, old.credential, undefined, {
      hello: { capabilities: ["thread_secrets"] },
      onSecretDelivery: ({ requestId, threadId, turnId, revision, remove, value, cwd }) => {
        oldFrames.push({ requestId, threadId, turnId, revision, remove, digest: Bun.hash(value), cwd });

        return undefined;
      },
    });

    const ws = (await gw.api.createWorkspace({ projectId, workerId: old.workerId, rootPath: "/repo" })).workspace!;
    const unsupported = await start(legacy, projectId, ws.id);
    expect(await request(unsupported, { worker: legacy })).toMatchObject({ isError: true });
    expect(await query("SELECT 1 FROM project_secret_leases WHERE turn_id=$1::uuid", unsupported.turnId)).toEqual([]);
    expect(oldFrames).toHaveLength(0);
    legacy.finish(unsupported.threadId, unsupported.turnId);

    const source = await start();
    const callId = Bun.randomUUIDv7();
    awaitingReceipt.add(callId);
    const requestResult = request(source, { callId });
    const countDeliveries = async () => events.filter((e) => e.requestId === callId && !e.remove).length;
    const receipt = { ...source, requestId: callId, revision: 1, rejected: true };
    await eventually(countDeliveries, (count) => count === 1);
    gw.worker.link.send({ case: "threadSecretReceipt", value: { ...receipt, turnId: unsupported.turnId } });
    await eventually(countDeliveries, (count) => count >= 2);
    gw.worker.link.send({ case: "threadSecretReceipt", value: receipt });
    expect(leaseResult(await requestResult)).toEqual({ request_id: callId, status: "revoked" });
    expect(await removed(callId)).toEqual([{ status: "revoked" }]);
    gw.worker.finish(source.threadId, source.turnId);
  }, 12_000);

  test("enforces the lifetime in PostgreSQL and expires a lease while its turn is still running", async () => {
    const source = await start();
    const lease = leaseResult(await request(source));
    await expect(
      query(
        "UPDATE project_secret_leases SET expires_at=created_at+interval '16 minutes' WHERE id=$1::uuid",
        lease.request_id,
      ),
    ).rejects.toThrow();
    await query(
      `UPDATE project_secret_leases SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute'
        WHERE id=$1::uuid`,
      lease.request_id,
    );
    expect(await removed(lease.request_id)).toEqual([{ status: "expired" }]);
    expect(leaseResult(await request(source, { callId: lease.request_id }))).toEqual({
      request_id: lease.request_id,
      status: "expired",
    });
    const renewed = leaseResult(await request(source));
    expect(renewed.status).toBe("saved");
    gw.worker.finish(source.threadId, source.turnId);
    expect(await removed(renewed.request_id)).toEqual([{ status: "expired" }]);
  }, 12_000);

  test("supports a shared worker and sends only cleanup when its connection is replaced", async () => {
    await query("UPDATE workers SET owner_user_id=NULL WHERE id=$1::uuid", gw.workerId);
    const source = await start();
    const first = leaseResult(await request(source));
    expect(first.file).toBe("/private/initial");
    gw.worker.link.close();
    const resumed = workerOptions("/private/reconnected");

    const worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
      ...resumed,
      resumeJournal: true,
      hello: { ...resumed.hello, runningTurns: [source] },
    });

    const again = leaseResult(await request(source, { worker, callId: first.request_id }));
    expect(again).toEqual({ request_id: first.request_id, status: "revoked" });
    expect(await removed(first.request_id)).toEqual([{ status: "revoked" }]);
    expect(events.filter((event) => event.requestId === first.request_id && !event.remove)).toHaveLength(1);
    worker.finish(source.threadId, source.turnId);
    await eventually(
      () => query("SELECT 1 FROM turns WHERE id=$1::uuid AND status='completed'", source.turnId),
      (rows) => rows.length === 1,
    );
    const next = await start(worker);
    const lease = leaseResult(await request(next, { worker }));
    expect(lease.file).toBe("/private/reconnected");
    const { secret } = await gw.api.revokeThreadSecret({ requestId: lease.request_id });
    expect(secret).toMatchObject({ projectSecret: secretName, status: "revoked" });
    expect(await removed(lease.request_id)).toEqual([{ status: "revoked" }]);
    worker.finish(next.threadId, next.turnId);
  });
});
