/** Throwaway gateway + web stack for the requested manual browser checks. Opt in with OA_ASK_BROWSER=1. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@open-agents/contracts";
import { tempDirs } from "@open-agents/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, SERVICE_TOKEN, startTestGateway } from "./support/gateway.ts";

const tempDir = tempDirs();
test.skipIf(process.env["OA_ASK_BROWSER"] !== "1")("questions: isolated browser fixture", async () => {
  const gw = await startTestGateway();
  const stop = join(tempDir("oa-question-browser-"), "stop");
  let web: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const projectId = (await gw.api.createProject({ name: "Question panel QA" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    gw.worker.holdTurns = true;
    const questions = [
      { id: "auth", header: "Auth method", question: "How should people sign in to the workspace?", kind: "single_choice", options: [{ label: "OAuth", description: "Sign in with an existing account. No passwords to maintain." }, { label: "Email and password", description: "Manage credentials within the application." }], recommended: "OAuth" },
      { id: "features", header: "Features", question: "Which features belong in the first release?", kind: "multiple_choice", options: [{ label: "Team invitations", description: "Invite collaborators by email." }, { label: "Audit log", description: "Keep a record of important changes." }, { label: "Custom roles" }] },
      { id: "notes", header: "Anything else?", question: "What else should I keep in mind?", kind: "text" },
    ];
    for (const wait of [true, false]) {
      const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: wait ? "Sync questions" : "Async questions", initialMessage: "Build workspace sign-in" })).thread!;
      const turnId = await eventually(async () => gw.runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${thread.id}::uuid AND status = 'running'`)[0]?.id;
      })), Boolean);
      if (!turnId) throw new Error("fixture turn did not start");
      const callId = Bun.randomUUIDv7();
      void gw.worker.callTool({ threadId: thread.id, turnId, callId, tool: "ask_user", args: { questions, wait } });
      await eventually(async () => gw.runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql`SELECT id FROM interaction_requests WHERE id = ${callId}::uuid`).length;
      })), (n) => n === 1);
      await gw.api.sendMessage({ threadId: thread.id, text: "Review the sign-in copy too", clientRequestId: `queue-${wait}` });
      if (wait) await gw.worker.callTool({ threadId: thread.id, turnId, tool: "spawn_thread", args: { title: "Review accessibility", prompt: "review", notify: false } });
      console.info(`BROWSER ${wait ? "sync" : "async"}: http://localhost:5293/threads/${thread.id}`);
    }
    web = Bun.spawn(["bun", "run", "--cwd", "apps/web", "dev", "--host", "0.0.0.0", "--port", "5293", "--strictPort"], {
      env: { ...process.env, GATEWAY_URL: gw.grpcUrl, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN }, stdout: "inherit", stderr: "inherit",
    });
    console.info(`BROWSER stop: ${stop}`);
    while (!existsSync(stop) && web.exitCode === null) await Bun.sleep(250);
    expect(web.exitCode).toBeNull();
  } finally {
    web?.kill();
    if (web) await web.exited;
    await gw.close();
  }
}, 1_800_000);
