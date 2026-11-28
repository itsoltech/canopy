import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { MOVE_NATIVE_SESSIONS } from "@canopy/domain/computers";
import { THREAD_TRANSFER_CAPABILITY } from "@canopy/domain/release/protocol";
import { ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { drainSource } from "../thread-transfers/runner.ts";
import { transferOperation, workerIo } from "../thread-transfers/worker-io.ts";
import { totalDigest, transferFiles, type TransferIo } from "../workspace-copy/transfer.ts";
import { movesState } from "./moves-context.ts";
import { movesUnary } from "./moves-recovery.ts";
import type { ComputerMoves } from "./moves.ts";
import { MoveRefused, type MoveRow } from "./move-payload.ts";

/**
 * Stage 8 with native continuation (docs/thread-transfers.md), source side: before PrepareMove this computer moves
 * the thread's harness session and files to a worker of the target through TransferMoveFiles, and the target
 * continues the same session in a new worktree. The preview says so; when it can't work out, the move fails with the
 * reason (the target drops what it staged) instead of quietly continuing from a handoff note.
 */

const FILES_TIMEOUT_MS = 10 * 60_000;

/** Checkouts this computer's moves are reading, released when the move is decided. */
const blocked = new Map<string, () => void>();

export function releaseCheckout(moveId: string) {
  blocked.get(moveId)?.();
  blocked.delete(moveId);
}

interface NativeFamily {
  id: string;
  provider: string;
  provider_profile_id: string | null;
  provider_thread_id: string | null;
  worker_id: string | null;
  cwd: string | null;
}

/** What the family needs to continue natively on `target`, or nothing when it continues from a handoff note. */
export async function nativeFamily(hostContext: ComputerMoves, family: readonly string[], target: string) {
  const core = hostContext[movesState].host.core;

  if (!(await hostContext[movesState].store.peer(target))?.capabilities.includes(MOVE_NATIVE_SESSIONS))
    return undefined;

  const rows = await hostContext[movesState].store.query<NativeFamily>(
    `SELECT id, provider, provider_profile_id, provider_thread_id, worker_id, cwd FROM threads
    WHERE id = ANY($1::uuid[]) AND owner_user_id = $2::uuid ORDER BY depth, id`,
    [family, hostContext[movesState].store.owner],
  );

  const main = rows[0];

  if (
    !main?.worker_id ||
    !main.cwd ||
    rows.length !== family.length ||
    rows.some(
      (t) =>
        !["claude", "codex"].includes(t.provider) ||
        !t.provider_thread_id ||
        t.cwd !== main.cwd ||
        t.worker_id !== main.worker_id,
    ) ||
    !core.link.connections.get(main.worker_id)?.hello.capabilities.includes(THREAD_TRANSFER_CAPABILITY)
  )
    return undefined;

  return { core, family: rows, worker: main.worker_id, cwd: main.cwd };
}

/**
 * Before the move reads the thread's history: a family moving with its session lets go of its worker first, so the
 * history sent along is as complete as the session (every event of the unloaded runtime is stored).
 */
export async function drainNative(hostContext: ComputerMoves, move: MoveRow, target: string) {
  if (!move.placement.nativeFiles) return;
  const found = await nativeFamily(hostContext, move.frozen.family ?? [move.item_id], target);

  // The confirmed mode needs its worker now (a worker reconnecting later would leave history behind).
  if (!found)
    throw new MoveRefused("This thread can no longer move with its session and files. Review the move again.");
  await drainSource(
    found.core,
    found.worker,
    found.family.map((t) => t.id),
    AbortSignal.timeout(FILES_TIMEOUT_MS),
  ).catch((error: Error) => {
    throw new MoveRefused(`The thread's session and files could not move: ${reasonOf(error)}`);
  });
}

type Action = NonNullable<NonNullable<MessageInitShape<typeof link.MoveFilesSchema>["operation"]>["action"]>;

/**
 * Moves the family's sessions and files to the target's worker. Returns what PrepareMove carries, or undefined when
 * the family continues from a handoff note (as the preview said). Fails with the reason when the move can't go on.
 */
export async function moveNative(
  hostContext: ComputerMoves,
  move: MoveRow,
  target: string,
): Promise<link.MoveNative | undefined> {
  const workspaceId = move.placement.workspaceId;

  // Only the mode the owner confirmed: a handoff note otherwise, and a new preview when it no longer fits.
  if (!move.placement.nativeFiles || !workspaceId) return undefined;
  const found = await nativeFamily(hostContext, move.frozen.family ?? [move.item_id], target);

  if (!found)
    throw new MoveRefused("This thread can no longer move with its session and files. Review the move again.");
  const { core, family, worker, cwd } = found;

  const remote = (files: MessageInitShape<typeof link.MoveFilesSchema>) =>
    movesUnary<link.MoveFilesReply>(
      hostContext,
      target,
      link.ComputerMoveService.method.transferMoveFiles,
      create(link.MoveFilesSchema, { moveId: move.id, workspaceId, ...files }),
      FILES_TIMEOUT_MS,
    );

  const step = async (action: Action) => (await remote({ operation: { action } })).result;
  // Held until the move's decision (movesDrive releases it): Canopy saves nothing into the checkout meanwhile.
  blocked.set(
    move.id,
    await core.threadTransfers.writes.block(worker, cwd).catch((error: Error) => {
      throw new MoveRefused(error.message);
    }),
  );
  const signal = AbortSignal.timeout(FILES_TIMEOUT_MS * 3);

  try {
    const sessions = family.map((t) => ({
      threadId: t.id,
      provider: t.provider,
      profileId: t.provider_profile_id ?? "",
      providerThreadId: t.provider_thread_id ?? "",
    }));

    // drainNative let go of the frozen family before its history was read; nothing has run since.
    const tips = await step({ case: "tips", value: {} });

    const exported = await transferOperation(
      core,
      worker,
      { action: { case: "export", value: { token: move.id, cwd, sessions, knownCommits: tips?.tips ?? [] } } },
      FILES_TIMEOUT_MS,
      signal,
    );

    const pkg = exported.package;

    if (!pkg) throw new InvalidError("This computer's worker did not export the thread.");
    await step({ case: "prepare", value: { token: move.id, entries: pkg.entries, bytes: pkg.bytes } });
    const local = workerIo(core, worker, worker, signal);

    const io: TransferIo = {
      read: local.read,
      write: async (chunks) => {
        await step({ case: "writeBatch", value: { token: move.id, chunks } });
      },
    };

    const hashes = await transferFiles(
      { source: move.id, target: move.id },
      pkg.entries,
      new Map(),
      io,
      signal,
      () => {},
    );

    const digest = totalDigest(pkg.entries, hashes);
    const staged = await step({ case: "stage", value: { token: move.id, sha256: digest } });

    const checkout = await remote({
      checkoutHead: staged?.head ?? pkg.head,
      checkoutBranch: staged?.branch ?? pkg.branch,
    });

    await step({ case: "apply", value: { token: move.id, cwd: checkout.worktreePath, sessions } });
    // Kept until the move is decided: verified again right before the commit, then released.
    undecided.set(move.id, { core, worker, cwd });

    return create(link.MoveNativeSchema, {
      worktreeId: checkout.worktreeId,
      cwd: checkout.worktreePath,
      sessions: Object.fromEntries(sessions.map((s) => [s.threadId, s.providerThreadId])),
    });
  } catch (error) {
    await discardNative(hostContext, move, target);
    await transferOperation(core, worker, { action: { case: "release", value: move.id } }).catch(() => undefined);
    throw new MoveRefused(
      `The thread's session and files could not move: ${reasonOf(error instanceof Error ? error : undefined)}`,
    );
  }
}

/** Packages this computer exported for moves still undecided. */
const undecided = new Map<string, { core: GatewayCore; worker: string; cwd: string }>();

/** Right before the commit, after the target prepared: nothing wrote to the checkout since its export. */
export async function verifyNative(moveId: string) {
  const pkg = undecided.get(moveId);

  if (!pkg) return;
  await transferOperation(
    pkg.core,
    pkg.worker,
    { action: { case: "verify", value: { token: moveId, cwd: pkg.cwd } } },
    FILES_TIMEOUT_MS,
  ).catch((error: Error) => {
    throw new MoveRefused(reasonOf(error));
  });
}

/** Once the move is decided either way: the source's package goes. Best effort (the worker sweeps leftovers). */
export async function releaseNative(moveId: string) {
  const pkg = undecided.get(moveId);
  undecided.delete(moveId);

  if (pkg)
    await transferOperation(pkg.core, pkg.worker, { action: { case: "release", value: moveId } }).catch(
      () => undefined,
    );
}

function reasonOf(error: Error | undefined) {
  if (error instanceof InvalidError || error instanceof MoveRefused) return error.message;

  if (error instanceof ConnectError) return error.rawMessage;

  return "Nothing was moved. Try again.";
}

/** Source, when the move does not go ahead with its native files: the target drops them. Best effort. */
export async function discardNative(hostContext: ComputerMoves, move: MoveRow, target: string) {
  await movesUnary(
    hostContext,
    target,
    link.ComputerMoveService.method.transferMoveFiles,
    create(link.MoveFilesSchema, { moveId: move.id, workspaceId: move.placement.workspaceId ?? "", discard: true }),
    FILES_TIMEOUT_MS,
  ).catch(() => undefined);
}
