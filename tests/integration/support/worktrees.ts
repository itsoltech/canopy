import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
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
import type { WorktreeRoots } from "../../../apps/worker/src/git/worktree-roots.ts";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Code, ConnectError } from "@connectrpc/connect";
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
export async function worktreeFixture(
  dir: string,
  options: {
    botModel?: BotModel;
    role?: "desktop" | "server";
    originUrl?: string;
    worktreeRoots?: WorktreeRoots;
    /** Announced besides the worktree ones (e.g. git_heads). */
    capabilities?: readonly string[];
  } = {},
) {
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

  if (options.originUrl) git(repo, "remote", "set-url", "origin", options.originUrl);
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

  const startHost = (worktreeRoots = options.worktreeRoots) =>
    new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      deviceHomes: { codex: home, claude: join(dir, "claude") },
      ...(worktreeRoots && { worktreeRoots }),
    });

  let host = startHost();

  let link: GatewayLink;
  const closing = new WeakSet<GatewayLink>();
  const sessions = new Set<Promise<void>>();
  const calls = new Map<string, (result: AgentToolResult) => void>();

  const connect = async () => {
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        homeDirectory: homedir(),
        capabilities: [
          "worktrees",
          "worktree_lifecycle",
          "workspace_origin",
          "workspace_clone_source",
          "project_sources",
          "workspace_copy_v1",
          "workspace_copy_scope_v2",
          ...(options.capabilities ?? []),
        ],
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

    const serving = serveLink({ ...link, messages: messages() }, host, runtime)
      .then(
        () => {},
        (cause) => {
          if (!(closing.has(active) && cause instanceof ConnectError && cause.code === Code.Unavailable)) throw cause;
        },
      )
      .finally(() => sessions.delete(serving));

    sessions.add(serving);
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

  const entry = async (id: string) => (await gw.api.listWorktrees({ worktreeId: id })).entries[0]!;

  // threadReady reports idle before createThread is acknowledged; queued turns can also outlive it.
  const settled = async (thread: ui.Thread) => {
    const state = await eventually(
      () =>
        gw.runtime.runPromise(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ status: string; busy: boolean }>`SELECT t.status,
            EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('queued','running')) OR
            EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id=t.id AND c.status IN ('pending','delivered')
              AND c.kind IN ('createThread','startTurn','setGoal') AND c.expires_at>now()) AS busy
            FROM threads t WHERE t.id=${thread.id}::uuid`,
          ).pipe(Effect.map((rows) => rows[0])),
        ),
      (state) => state?.status === "idle" && !state.busy,
    );

    expect(state).toMatchObject({ status: "idle", busy: false });
    // Checkout aliases have no worktree id; their own durable admission must still settle above.
    const worktree = thread.worktree;

    if (!worktree) return;

    const scanned = await eventually(
      () => entry(worktree.id),
      (entry) => !entry.busy && (worktree.external || entry.status !== undefined),
    );

    expect(scanned.busy).toBe(false);

    // External worktrees are discovered, never scanned for cleanup.
    if (!worktree.external) expect(scanned.status).toBeDefined();
  };

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

    await settled(thread);
    rmSync(join(thread.cwd, "worker-started.txt"));

    return thread;
  };

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
    get host() {
      return host;
    },
    runtime,
    gw,
    workerId,
    project,
    workspace,
    tree,
    settled,
    entry,
    settings,
    remove,
    cleanup,
    connect,
    disconnect: () => {
      closing.add(link);
      link.close();
    },
    /** A message on the worker's link, as a worker could send it. */
    send: (payload: Parameters<GatewayLink["send"]>[0]) => link.send(payload),
    /** A new worker process on the same data directory (an upgrade), with other worktree roots. */
    restart: async (worktreeRoots?: WorktreeRoots) => {
      closing.add(link);
      link.close();
      await host.close();
      host = startHost(worktreeRoots);
      await connect();
    },
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
      closing.add(link);
      link.close();
      await host.close();
      await Promise.all(sessions);
      await runtime.dispose();
      await gw.close();
    },
  };
}
