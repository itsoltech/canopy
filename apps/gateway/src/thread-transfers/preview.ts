import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HARNESS_NAMES, isHarness, providerOf } from "@canopy/domain/harnesses";
import { THREAD_TRANSFER_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { familyBlocker } from "./fences.ts";
import { familyOf, type SessionPlan } from "./store.ts";
import { transferOperation } from "./worker-io.ts";

/**
 * What moving a thread to another worker would do (docs/thread-transfers.md): the target workspaces, the provider
 * instance there, the thread's changes and local files, and why it can't move now.
 */

export interface TransferPlan {
  preview: ui.ThreadTransferPreview;
  family: string[];
  sessions: SessionPlan[];
  source: ui.Worker;
  target: ui.Worker;
  sourceWorkspaceId: string;
  sourceCwd: string;
  sourceWorktreeId: string | null;
}

export async function planTransfer(core: GatewayCore, threadId: string, workerId: string): Promise<TransferPlan> {
  const owner = core[coreState].options.userId;
  const { actions } = core[coreState];

  const { main, family } = await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* familyOf(sql, owner, threadId);
    }),
  );

  const preview = create(ui.ThreadTransferPreviewSchema, { threads: family.length });
  const workers = (await coreWorkers(core)).filter((w) => !w.nodeId);
  const source = workers.find((w) => w.id === main.worker_id);
  const target = workers.find((w) => w.id === workerId);

  if (!source || !target || !main.cwd || !main.workspace_id) throw new InvalidError("worker not found");
  const sessions: SessionPlan[] = [];

  const base = {
    preview,
    family: family.map((t) => t.id),
    sessions,
    source,
    target,
    sourceWorkspaceId: main.workspace_id,
    sourceCwd: main.cwd,
    sourceWorktreeId: main.worktree_id,
  };

  const block = (reason: string) => {
    preview.blocked ||= reason;

    return base;
  };

  if (source.id === target.id) return block("The thread already runs on this worker.");

  for (const worker of [source, target]) {
    if (!worker.online) return block(`${worker.name} is offline.`);

    if (!core.link.connections.get(worker.id)?.hello.capabilities.includes(THREAD_TRANSFER_CAPABILITY))
      return block(`Update ${worker.name} to move threads.`);
  }

  const projects = await coreRun(core, (s) => s.listProjects(owner));
  const project = projects.find((p) => p.workspaces.some((w) => w.id === main.workspace_id));

  if (!project || project.kind === "scratch") return block("Threads without a project can't move yet.");
  preview.workspaceIds = project.workspaces.filter((w) => w.workerId === target.id).map((w) => w.id);

  if (!preview.workspaceIds.length)
    return block(`Add this project on ${target.name} first, for example by copying its workspace there.`);

  if (!target.worktrees) return block(`Update ${target.name} to create worktrees.`);

  const blocked = await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* familyBlocker(sql, owner, base.family);
    }),
  );

  if (blocked) return block(blocked);

  for (const thread of family) {
    const instance = targetInstance(target, thread.provider, thread.provider_profile_id ?? "");

    if (!instance || !isHarness(thread.provider))
      return block(
        `Set up ${HARNESS_NAMES[isHarness(thread.provider) ? thread.provider : "claude"]} on ${target.name} first.`,
      );

    if (thread.id === main.id) preview.instanceLabel = instance.label;
    sessions.push({
      threadId: thread.id,
      provider: thread.provider,
      providerThreadId: thread.provider_thread_id ?? "",
      sourceProfileId: thread.provider_profile_id ?? "",
      targetProfileId: instance.id === "native" ? "" : instance.id,
    });
  }

  const inspected = await transferOperation(core, source.id, {
    action: {
      case: "inspect",
      value: {
        cwd: main.cwd,
        sessions: sessions.map((s) => ({
          threadId: s.threadId,
          provider: s.provider,
          profileId: s.sourceProfileId,
          providerThreadId: s.providerThreadId,
        })),
      },
    },
  });

  const summary = inspected.summary;

  if (!summary) return block("The thread's worker did not describe the thread.");

  if (summary.blocked) return block(summary.blocked);

  if (summary.missingSessions.length) return block(`The agent's session of this thread is missing on ${source.name}.`);
  Object.assign(preview, {
    branch: summary.branch,
    head: summary.head,
    changedFiles: summary.changedFiles,
    untrackedFiles: summary.untrackedFiles,
    unpushedCommits: summary.unpushedCommits,
    localFiles: summary.localFiles.map((f) =>
      create(ui.ThreadTransferLocalFileSchema, { path: f.path, size: f.size, secret: f.secret }),
    ),
    redo: await redo(core, base.family, target.name),
  });

  return base;
}

/** The same instance on the target, else the first ready instance of the same harness there. */
function targetInstance(target: ui.Worker, provider: string, profileId: string) {
  const harness = providerOf(provider);
  const ready = target.providerInstances.filter((i) => i.harness === harness && i.enabled && i.available);

  return ready.find((i) => i.id === (profileId || "native")) ?? ready[0];
}

async function redo(core: GatewayCore, family: readonly string[], target: string) {
  const secrets = await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql.unsafe(
        `SELECT 1 FROM thread_secrets WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','saved') LIMIT 1`,
        [family],
      );

      return rows.length > 0;
    }),
  );

  return [
    `Dependencies and build output stay behind. Install them again on ${target}.`,
    ...(secrets ? ["Secrets given to the agent stay behind. It asks for them again."] : []),
  ];
}
