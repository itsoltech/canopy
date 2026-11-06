import type { GatewayCore } from "../core/core.ts";
import { coreBroadcastThread, coreLog, coreRun } from "../core/core-broadcast.ts";
import { coreGenerateText } from "../core/core-titles.ts";
import type { ThreadRow } from "../store/index.ts";
import type { WorktreeRow } from "../store/worktrees.ts";
import { branchPrompt, semanticBranch, unclearBranch } from "./branch-names.ts";

/**
 * Generated branch names (docs/worktrees.md, "Nazwy gałęzi"). A SEMANTIC worktree starts on a provisional name.
 * The gateway asks the text-generation model for `<type>/<slug>` after creation (first message) and after the next
 * turns (the conversation so far), until a name is set or MAX_ATTEMPTS are used. The worker renames only while the
 * branch is still checked out, has no upstream, was never pushed and HEAD never left it. Nothing here can fail the
 * thread: every failure keeps the current name.
 */

export const MAX_ATTEMPTS = 3;

const RENAME_TIMEOUT_MS = 20_000;

/**
 * Per gateway: worktrees with a generation in flight (one at a time) and the conversation each was last asked
 * about (the same text is not asked twice, e.g. a first turn that ended without an answer). The database claim
 * counts the attempts.
 */
const naming = new WeakMap<GatewayCore, { running: Set<string>; asked: Map<string, string> }>();

function namingState(hostContext: GatewayCore) {
  let state = naming.get(hostContext);

  if (!state) naming.set(hostContext, (state = { running: new Set(), asked: new Map() }));

  return state;
}

/** The conversation as the prompt shows it: the user's requests and the agent's latest answer. */
function conversation(context: { requests: readonly string[]; answer: string }): string {
  return [...context.requests.map((r) => `User: ${r}`), ...(context.answer ? [`Agent: ${context.answer}`] : [])].join(
    "\n\n",
  );
}

async function attempt(
  hostContext: GatewayCore,
  thread: ThreadRow,
  worktreeId: string,
  context: () => Promise<string>,
): Promise<void> {
  const connection = hostContext.link.connections.get(thread.worker_id ?? "");

  if (!connection?.isOpen) return;
  const capable = connection.hello.capabilities.includes("provisional_branches");
  const text = await context();
  const { asked } = namingState(hostContext);

  if (!text.trim() || asked.get(worktreeId) === text) return;
  // An older worker cannot tell a pushed or switched branch: one attempt, at creation (as before).
  const worktree = await coreRun(hostContext, (s) => s.claimBranchName(worktreeId, capable ? MAX_ATTEMPTS : 1));

  if (!worktree || worktree.worker_id !== thread.worker_id) {
    asked.delete(worktreeId);

    return;
  }

  asked.set(worktreeId, text);
  const answer = await coreGenerateText(hostContext, thread, () => branchPrompt(text));
  const name = unclearBranch(answer) ? undefined : semanticBranch(answer);

  if (!name || name === worktree.branch) return; // unclear or unusable: the next turn tries again
  await rename(hostContext, worktree, name, capable);
}

async function rename(hostContext: GatewayCore, worktree: WorktreeRow, name: string, provisional: boolean) {
  const connection = hostContext.link.connections.get(worktree.worker_id);

  if (!connection?.isOpen) return;

  const result = await connection.sendCommand(
    {
      case: "renameWorktreeBranch",
      value: {
        path: worktree.path,
        fromBranch: worktree.branch,
        toBranch: name,
        location: worktree.location,
        provisional,
      },
    },
    RENAME_TIMEOUT_MS,
  );

  if (!result.ok) return; // git busy or offline: a later turn may try again
  const renamed = result.worktree?.renamed ? result.worktree.branch : undefined;

  namingState(hostContext).asked.delete(worktree.id);

  if (!renamed) {
    // The worker refused for good: pushed, upstream, switched or renamed by hand.
    await coreRun(hostContext, (s) => s.keepBranch(worktree.id));

    return;
  }

  const threads = await coreRun(hostContext, (s) => s.renameWorktree(worktree.id, worktree.branch, renamed));

  for (const id of threads) await coreBroadcastThread(hostContext, id);
}

function launch(hostContext: GatewayCore, thread: ThreadRow, worktreeId: string, context: () => Promise<string>) {
  const { running } = namingState(hostContext);

  if (running.has(worktreeId)) return;
  running.add(worktreeId);
  void attempt(hostContext, thread, worktreeId, context)
    .catch(() => coreLog(hostContext, `worktree ${worktreeId}: branch name unavailable; kept`))
    .finally(() => running.delete(worktreeId));
}

/** Right after creation, from the first message: the thread is already running on the provisional name. */
export function coreNameBranchLater(
  hostContext: GatewayCore,
  thread: ThreadRow,
  message: string,
  worktree: Pick<WorktreeRow, "id">,
): void {
  launch(hostContext, thread, worktree.id, async () => conversation({ requests: [message], answer: "" }));
}

/** After a turn of a thread in a worktree that still has a provisional name: the conversation so far. */
export function coreNameBranchAfterTurn(hostContext: GatewayCore, threadId: string): void {
  void (async () => {
    const thread = await coreRun(hostContext, (s) => s.thread(threadId));

    if (!thread.worktree_id || thread.worktree?.branch_source !== "provisional" || thread.worktree.removed_at) return;

    launch(hostContext, thread, thread.worktree_id, async () =>
      conversation(await coreRun(hostContext, (s) => s.branchContext(threadId))),
    );
  })().catch(() => coreLog(hostContext, `thread ${threadId}: branch name check unavailable`));
}
