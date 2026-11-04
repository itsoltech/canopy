import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import type { BotModel } from "../../../apps/gateway/src/bots/types.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway } from "./gateway.ts";

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });

  if (result.exitCode) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

export function commit(path: string, file = "README.md", text = Bun.randomUUIDv7()): string {
  writeFileSync(join(path, file), text);
  git(path, "add", file);
  git(path, "commit", "-qm", "change");

  return git(path, "rev-parse", "HEAD");
}

/** Real git + WorkerHost + gateway + PostgreSQL, without contacting any model provider. */
export async function worktreeFixture(dir: string, options: { botModel?: BotModel } = {}) {
  const data = join(dir, "data");
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  const home = join(dir, "codex-home");
  const executable = join(dir, "codex");
  mkdirSync(data);
  mkdirSync(home);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
  copyFileSync(new URL("../fixtures/directory-codex.ts", import.meta.url), executable);
  chmodSync(executable, 0o755);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  commit(repo);
  git(repo, "push", "-qu", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  const gw = await startTestGateway(options);
  const worker = await gw.addWorker("Worktree lifecycle");
  const workerId = worker.workerId;
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        workerId,
        {
          codex: { enabled: true, executablePath: executable },
          claude: { enabled: false },
        },
        gw.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir: data,
    clientVersion: "test",
    deviceHomes: { codex: home, claude: join(dir, "claude") },
  });

  let link: GatewayLink;
  const calls = new Map<string, (result: AgentToolResult) => void>();

  const connect = async () => {
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        homeDirectory: homedir(),
        capabilities: ["worktrees", "worktree_lifecycle"],
        worktreesRoot: host.worktreesRoot,
        ...(await runtime.runPromise(journalHello())),
      },
    });
    const active = link;

    const messages = async function* () {
      for await (const message of active.messages) {
        if (message.payload.case === "agentToolResult")
          calls.get(message.payload.value.callId)?.(message.payload.value);
        else yield message;
      }
    };

    void serveLink({ ...link, messages: messages() }, host, runtime);
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === workerId && w.appliedVersion > 0n && w.online),
    );
  };

  await connect();
  const project = (await gw.api.createProject({ name: "Lifecycle" })).project!;
  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: repo })).workspace!;

  const settings = async (changes: Partial<ui.WorktreeSettings>, projectId = project.id, scopeWorker = workerId) => {
    const current = await gw.api.getWorktreeSettings({ projectId, workerId: scopeWorker });

    return gw.api.updateWorktreeSettings({
      projectId,
      workerId: scopeWorker,
      expectedVersion: current.version,
      settings: { ...current.settings, ...changes },
    });
  };

  await settings({ branchNaming: ui.BranchNaming.PREFIX });

  const tree = async () => {
    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        baseRef: "main",
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    rmSync(join(thread.cwd, "worker-started.txt"));

    return thread;
  };

  const entry = async (id: string) => (await gw.api.listWorktrees({ worktreeId: id })).entries[0]!;

  const remove = async (id: string, confirm = false) =>
    gw.api.removeWorktree({
      worktreeId: id,
      confirmLocalChanges: confirm,
      expectedHeadCommit: (await entry(id)).status?.headCommit ?? "",
    });

  const cleanup = (dryRun = true) => gw.api.cleanupWorktrees({ projectId: project.id, workerId, dryRun });

  return {
    dir,
    data,
    repo,
    origin,
    host,
    runtime,
    gw,
    workerId,
    project,
    workspace,
    tree,
    entry,
    settings,
    remove,
    cleanup,
    connect,
    disconnect: () => link.close(),
    sql: <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, import("effect/sql").SqlError.SqlError>) =>
      gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, query)),
    command: (kind: MessageInitShape<typeof CommandSchema>) => host.handleCommand(create(CommandSchema, kind)),
    callTool: (threadId: string, args: JsonValue, callId = Bun.randomUUIDv7()) =>
      new Promise<AgentToolResult>((resolve) => {
        calls.set(callId, (result) => {
          calls.delete(callId);
          resolve(result);
        });
        link.send({
          case: "agentToolCall",
          value: { callId, threadId, toolName: "spawn_thread", argumentsJson: JSON.stringify(args) },
        });
      }),
    close: async () => {
      link.close();
      await host.close();
      await runtime.dispose();
      await gw.close();
    },
  };
}
