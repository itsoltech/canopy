import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import type { ThreadSecretDelivery } from "@canopy/contracts";
import { AgentTool, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { PROJECT_SECRET_LEASES } from "@canopy/domain";
import { PROJECT_LOGINS } from "@canopy/domain/project-logins";
import { Code } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

type Scope = { threadId: string; turnId: string };

const site = "https://staging.example.test";
const setup = "otpauth://totp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const login = (overrides: Partial<{ askEachTime: boolean; outsideBrowser: boolean; showUsername: boolean }> = {}) => ({
  websites: [`${site}/login`, "*.example.test"],
  username: "abc@example.test",
  showUsername: overrides.showUsername ?? true,
  notes: "Admin role",
  askEachTime: overrides.askEachTime ?? false,
  outsideBrowser: overrides.outsideBrowser ?? false,
  oneTimeCode: false,
});

describe.skipIf(!dockerAvailable)("project logins (gateway ↔ worker)", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const deliveries: ThreadSecretDelivery[] = [];

  const query = <A extends object>(text: string, ...params: string[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }),
    );

  async function start(): Promise<Scope> {
    gw.worker.holdTurns = true;

    const { thread } = await gw.api.createThread({
      projectId,
      workspaceId,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.FULL_AUTO,
      title: "Project logins",
      initialMessage: "sign in",
    });

    const threadId = thread!.id;

    const turns = await eventually(
      () => query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid AND status='running'", threadId),
      (rows) => rows.length === 1,
    );

    return { threadId, turnId: turns[0]!.id };
  }

  /** The admitted Agent Browser call a lease belongs to, as the worker's bridge asks for it. */
  async function authorize(scope: Scope, login: string, tool = "agent_browser_fill_login") {
    const callId = Bun.randomUUIDv7();

    const result = await gw.worker.callTool({
      ...scope,
      callId,
      tool: "authorize_local_automation",
      args: { tool: AgentTool.BROWSER, name: tool, arguments: JSON.stringify({ login }) },
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result.isError).toBe(false);

    return callId;
  }

  const lease = async (scope: Scope, name: string, origin = site, authorization?: string) =>
    gw.worker.callTool({
      ...scope,
      tool: "lease_project_login",
      args: { name, origin, authorization: authorization ?? (await authorize(scope, name)) },
    });

  const decisions = (scope: Scope, name: string) =>
    query<{ id: string; access: string; status: string }>(
      "SELECT id,access,status FROM project_login_decisions WHERE thread_id=$1::uuid AND name=$2 ORDER BY created_at",
      scope.threadId,
      name,
    );

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: {
        hello: { capabilities: [PROJECT_SECRET_LEASES, PROJECT_LOGINS, "running_turns", "agent_tools_v1"] },
        onSecretDelivery: (delivery) => {
          deliveries.push(delivery);

          return {
            requestId: delivery.requestId,
            threadId: delivery.threadId,
            turnId: delivery.turnId,
            revision: delivery.revision,
            applied: true,
            file: delivery.remove || delivery.memoryOnly ? "" : "/private/login",
          };
        },
      },
    });
    gw.worker.link.send({
      case: "agentToolsReport",
      value: { tools: [{ tool: AgentTool.BROWSER, installed: true, ready: true, version: "0.43.0" }] },
    });
    await eventually(
      async () => (await gw.api.getOverview({})).workers.find((worker) => worker.id === gw.workerId),
      (worker) => Boolean(worker?.agentTools.length),
    );
    await gw.api.setAgentToolEnabled({ workerId: gw.workerId, tool: AgentTool.BROWSER, enabled: true });
    projectId = (await gw.api.createProject({ name: "Project logins" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("stores the password write-only and keeps it when only the details change", async () => {
    const password = `pw-${crypto.randomUUID()}`;

    const created = await gw.api.putProjectLogin({
      projectId,
      name: "STAGING_ADMIN",
      login: login(),
      password,
      oneTimeCodeSetup: setup,
    });

    expect(created.secret).toMatchObject({
      kind: "login",
      login: { websites: [site, "https://*.example.test"], username: "abc@example.test", oneTimeCode: true },
    });
    expect(toJsonString(ui.ProjectSecretSchema, created.secret!)).not.toContain(password);

    const [stored] = await query<{ hidden: boolean }>(
      `SELECT position(convert_to($2, 'UTF8') in ciphertext)=0 AND login::text NOT LIKE '%' || $2 || '%' AS hidden
        FROM project_logins WHERE project_id=$1::uuid AND name='STAGING_ADMIN'`,
      projectId,
      password,
    );

    expect(stored).toEqual({ hidden: true });

    await gw.api.putProjectLogin({ projectId, name: "STAGING_ADMIN", login: { ...login(), notes: "Edited" } });
    const scope = await start();
    const result = JSON.parse((await lease(scope, "STAGING_ADMIN")).content);
    expect(result.status).toBe("saved");
    const delivered = deliveries.find((delivery) => delivery.requestId === result.request_id && !delivery.remove);
    expect(delivered?.memoryOnly).toBe(true);
    expect(JSON.parse(delivered!.value)).toMatchObject({ password, one_time_code_setup: setup, hide_username: false });
    gw.worker.finish(scope.threadId, scope.turnId);

    await expect(
      gw.api.putProjectSecret({ projectId, name: "STAGING_ADMIN", value: "replaced" }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(gw.api.putProjectLogin({ projectId, name: "NEW_LOGIN", login: login() })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(
      gw.api.putProjectLogin({ projectId, name: "BAD_SITE", login: { ...login(), websites: ["ftp://x"] }, password }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
  }, 20_000);

  test("lists logins for the agent without secrets and leases them only for their websites", async () => {
    const password = `pw-${crypto.randomUUID()}`;
    await gw.api.putProjectLogin({
      projectId,
      name: "HIDDEN_USER",
      login: {
        ...login({ showUsername: false }),
        websites: ["*.example.test", "https://PR-*.app.preview.test:8443/login"],
      },
      password,
    });
    await gw.api.putProjectSecret({ projectId, name: "API_TOKEN", value: "token" });
    const scope = await start();
    const listed = (await gw.worker.callTool({ ...scope, tool: "list_project_secrets", args: {} })).content;
    expect(listed).not.toContain(password);
    expect(JSON.parse(listed)).toMatchObject({
      names: ["API_TOKEN"],
      logins: expect.arrayContaining([expect.objectContaining({ name: "HIDDEN_USER", username: "hidden" })]),
    });

    for (const origin of ["https://pr-1090.app.preview.test:8443", "https://nested.app.example.test"]) {
      expect(JSON.parse((await lease(scope, "HIDDEN_USER", origin)).content).status).toBe("saved");
    }

    for (const origin of [
      "https://example.test",
      "https://staging.app.preview.test:8443",
      "https://pr-.app.preview.test:8443",
      "https://pr-1090.nested.app.preview.test:8443",
      "https://pr-1090.api.preview.test:8443",
      "https://pr-1090.app.preview.test.example.org:8443",
      "http://pr-1090.app.preview.test:8443",
      "https://pr-1090.app.preview.test",
    ]) {
      const denied = await lease(scope, "HIDDEN_USER", origin);
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain(`not for ${origin}.`);
    }

    const file = await gw.worker.callTool({
      ...scope,
      tool: "request_secret",
      args: { project_secret: "HIDDEN_USER" },
    });

    expect(file.isError).toBe(true);
    gw.worker.finish(scope.threadId, scope.turnId);
  }, 20_000);

  test("a lease needs the live browser action that names the login", async () => {
    await gw.api.putProjectLogin({ projectId, name: "BOUND", login: login(), password: `pw-${crypto.randomUUID()}` });
    await gw.api.putProjectLogin({ projectId, name: "OTHER", login: login(), password: `pw-${crypto.randomUUID()}` });
    const scope = await start();
    const refused = "only from an allowed Agent Browser login action";

    expect((await lease(scope, "BOUND", site, Bun.randomUUIDv7())).content).toContain(refused);
    expect((await lease(scope, "BOUND", site, await authorize(scope, "OTHER"))).content).toContain(refused);
    expect(
      (await lease(scope, "BOUND", site, await authorize(scope, "BOUND", "agent_browser_eval"))).content,
    ).toContain(refused);
    expect(deliveries.some((delivery) => delivery.turnId === scope.turnId)).toBe(false);
    expect(JSON.parse((await lease(scope, "BOUND")).content).status).toBe("saved");
    gw.worker.finish(scope.threadId, scope.turnId);
  }, 20_000);

  test("an answer that arrives after the browser action ended waits for the next action", async () => {
    await gw.api.putProjectLogin({
      projectId,
      name: "LATE",
      login: login({ askEachTime: true }),
      password: `pw-${crypto.randomUUID()}`,
    });
    const scope = await start();
    const authorization = await authorize(scope, "LATE");
    const leased = lease(scope, "LATE", site, authorization);

    const [pending] = await eventually(
      () => decisions(scope, "LATE"),
      (rows) => rows[0]?.status === "pending",
    );

    gw.worker.link.send({ case: "localAutomationFinished", value: { callId: authorization } });
    await gw.api.answerThreadSecret({ requestId: pending!.id, decline: false });
    expect(JSON.parse((await leased).content).status).toBe("expired");
    expect(
      await query("SELECT id FROM project_secret_leases WHERE thread_id=$1::uuid AND name='LATE'", scope.threadId),
    ).toEqual([]);

    // The owner's answer stays for the turn.
    expect(JSON.parse((await lease(scope, "LATE")).content).status).toBe("saved");
    gw.worker.finish(scope.threadId, scope.turnId);
  }, 30_000);

  test("a login that asks each time waits for the owner, and one answer covers the turn", async () => {
    await gw.api.putProjectLogin({
      projectId,
      name: "PRODUCTION",
      login: login({ askEachTime: true }),
      password: `pw-${crypto.randomUUID()}`,
    });
    await gw.api.putProjectLogin({
      projectId,
      name: "DECLINED",
      login: login({ askEachTime: true }),
      password: `pw-${crypto.randomUUID()}`,
    });
    const scope = await start();

    const answer = async (name: string, decline: boolean) => {
      const [pending] = await eventually(
        () => decisions(scope, name),
        (rows) => rows.length === 1 && rows[0]!.status === "pending",
      );

      expect(
        await query("SELECT id FROM project_secret_leases WHERE thread_id=$1::uuid AND name=$2", scope.threadId, name),
      ).toEqual([]);
      const { secret } = await gw.api.answerThreadSecret({ requestId: pending!.id, decline });
      expect(secret).toMatchObject({ kind: "login", access: "browser", status: decline ? "declined" : "saved" });
    };

    // Concurrent fills share one question.
    const [allowed, again] = await Promise.all([
      lease(scope, "PRODUCTION"),
      lease(scope, "PRODUCTION"),
      answer("PRODUCTION", false),
    ]);

    expect(JSON.parse(allowed.content).status).toBe("saved");
    expect(JSON.parse(again.content).status).toBe("saved");
    expect(await decisions(scope, "PRODUCTION")).toHaveLength(1);

    const [declined] = await Promise.all([lease(scope, "DECLINED"), answer("DECLINED", true)]);
    expect(JSON.parse(declined.content).status).toBe("declined");
    expect(JSON.parse((await lease(scope, "DECLINED")).content).status).toBe("declined");

    gw.worker.finish(scope.threadId, scope.turnId);
    await eventually(
      () => decisions(scope, "PRODUCTION"),
      (rows) => rows.every((row) => row.status === "expired"),
    );
  }, 30_000);

  test("a login file outside the browser asks too, separately from the browser", async () => {
    const password = `pw-${crypto.randomUUID()}`;

    await gw.api.putProjectLogin({
      projectId,
      name: "API_LOGIN",
      login: login({ askEachTime: true, outsideBrowser: true }),
      password,
    });
    const scope = await start();

    const request = () =>
      gw.worker.callTool({ ...scope, tool: "request_secret", args: { project_secret: "API_LOGIN" } });

    expect(JSON.parse((await request()).content)).toMatchObject({ status: "pending", approval: "waiting_for_owner" });
    const [file] = await decisions(scope, "API_LOGIN");
    expect(file).toMatchObject({ access: "file", status: "pending" });
    expect(deliveries.some((delivery) => delivery.turnId === scope.turnId)).toBe(false);

    await gw.api.answerThreadSecret({ requestId: file!.id, decline: false });
    const granted = JSON.parse((await request()).content);
    expect(granted).toMatchObject({ status: "saved", file: "/private/login" });
    const delivered = deliveries.find((delivery) => delivery.requestId === granted.request_id && !delivery.remove);
    expect(delivered).toMatchObject({ login: true, memoryOnly: false });
    expect(JSON.parse(delivered!.value)).toMatchObject({ password });

    // The file answer does not allow Agent Browser: that asks on its own.
    const [browser] = await Promise.all([
      lease(scope, "API_LOGIN"),
      eventually(
        () => decisions(scope, "API_LOGIN"),
        (rows) => rows.some((row) => row.access === "browser" && row.status === "pending"),
      ).then((rows) =>
        gw.api.answerThreadSecret({ requestId: rows.find((row) => row.access === "browser")!.id, decline: true }),
      ),
    ]);

    expect(JSON.parse(browser.content).status).toBe("declined");
    gw.worker.finish(scope.threadId, scope.turnId);
  }, 30_000);

  test("logins live apart from project secrets, which an older gateway reads", async () => {
    await gw.api.putProjectLogin({ projectId, name: "SEPARATE", login: login(), password: "pw" });

    expect(
      await query("SELECT name FROM project_secrets WHERE project_id=$1::uuid AND name='SEPARATE'", projectId),
    ).toEqual([]);

    // A gateway that predates logins writes project_secrets directly: the name stays taken.
    await expect(
      query(
        "INSERT INTO project_secrets(project_id,name,ciphertext,key_id) VALUES ($1::uuid,'SEPARATE','\\x00','k')",
        projectId,
      ),
    ).rejects.toThrow();
  }, 20_000);
});
