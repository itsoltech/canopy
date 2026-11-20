import { createHash, type Hash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkspaceCopyBatch,
  WorkspaceCopyChunk,
  WorkspaceCopyEntry,
  WorkspaceCopyFinish,
  WorkspaceCopyPrepare,
} from "@canopy/contracts";
import { COPY_FRAME_BYTES, COPY_FRAME_FILES, COPY_IDLE_MS } from "@canopy/domain/workspace-copy";
import { newDirectory } from "../git/project-sources.ts";
import { freshGit, git } from "../git/git.ts";
import { rebuildCopyGitMetadata } from "./git-metadata.ts";
import { copyError, checkedPath, sameIdentity } from "./safety.ts";
import { CopyReceipts, type CopyReceipt } from "./receipts.ts";
import { mapLimit } from "./limit.ts";
import {
  settle,
  stagedFiles,
  syncDirectory,
  syncFiles,
  validateEntries,
  writePiece,
  type Staged,
} from "./target-files.ts";

interface TargetSession {
  receipt: CopyReceipt;
  entries: Map<string, WorkspaceCopyEntry>;
  /** Verified complete files and their SHA-256, the total digest's input. */
  done: Map<string, string>;
  /** Files an earlier attempt left; each becomes done when the source confirms the same hash. */
  staged: Map<string, string>;
  /** Large files being written piece by piece. */
  writing: Map<string, { offset: number; hash: Hash }>;
  dirs: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

const WRITE_CONCURRENCY = 8;
const TARGETS = 4;

export class CopyTargets {
  readonly #sessions = new Map<string, TargetSession>();
  readonly receipts: CopyReceipts;
  readonly ready: Promise<void>;
  constructor(dataDir: string) {
    this.receipts = new CopyReceipts(dataDir);
    this.ready = this.receipts.recover();
  }

  /** A new private staging directory, or the one an interrupted transfer with this token left (`resume`). */
  async prepare(request: WorkspaceCopyPrepare): Promise<{ directory: string; staged: Staged[] }> {
    await this.ready;
    const old = await this.receipts.load(request.token);

    if (old?.state === "committed") {
      if (!(await sameIdentity(old.target, old.stageDev, old.stageIno)))
        throw copyError("The copied directory changed. Choose another destination.");

      return { directory: old.target, staged: [] };
    }

    if (old && request.resume && old.state === "writing")
      return { directory: "", staged: await this.#resume(old, request) };

    if (old || this.#sessions.size >= TARGETS)
      throw copyError("A copy is already in progress. Cancel it before retrying.");
    await this.receipts.recover(new Set(this.#sessions.keys()));
    validateEntries(request.entries, request.bytes);
    const { parent, target } = newDirectory(request.parentPath, request.name);
    const targetInfo = await lstat(target);

    const stage = await mkdtemp(join(parent, ".canopy-copy-")).catch(async (error) => {
      if (await sameIdentity(target, targetInfo.dev, targetInfo.ino)) await rmdir(target);
      throw error;
    });

    const stageInfo = await lstat(stage);

    const receipt: CopyReceipt = {
      token: request.token,
      parent,
      target,
      stage,
      state: "writing",
      digest: "",
      targetDev: targetInfo.dev,
      targetIno: targetInfo.ino,
      stageDev: stageInfo.dev,
      stageIno: stageInfo.ino,
      updated: Date.now(),
    };

    try {
      await chmod(stage, 0o700);
      await this.receipts.save(receipt);
      await this.#open(receipt, request.entries, []);

      return { directory: "", staged: [] };
    } catch (error) {
      await this.cancel(request.token);
      await this.receipts.clean(receipt);
      throw error;
    }
  }

  async #resume(receipt: CopyReceipt, request: WorkspaceCopyPrepare) {
    this.#drop(request.token);

    if (
      !(await sameIdentity(receipt.stage, receipt.stageDev, receipt.stageIno)) ||
      !(await sameIdentity(receipt.target, receipt.targetDev, receipt.targetIno))
    ) {
      await this.receipts.clean(receipt);
      throw copyError("The destination changed while copying. Choose another directory.");
    }

    if (this.#sessions.size >= TARGETS) throw copyError("A copy is already in progress. Cancel it before retrying.");
    validateEntries(request.entries, request.bytes);
    const staged = await stagedFiles(receipt.stage, new Map(request.entries.map((e) => [e.path, e])));
    await this.receipts.save({ ...receipt, updated: Date.now() });
    await this.#open(receipt, request.entries, staged);

    return staged;
  }

  async #open(receipt: CopyReceipt, entries: readonly WorkspaceCopyEntry[], staged: readonly Staged[]) {
    const session: TargetSession = {
      receipt,
      entries: new Map(entries.map((e) => [e.path, e])),
      done: new Map(),
      staged: new Map(staged.map((s) => [s.path, s.sha256])),
      writing: new Map(),
      dirs: new Set(),
      // Idle: forget the session; the staged files wait for a resume until the receipt expires.
      timer: setTimeout(() => this.#drop(receipt.token), COPY_IDLE_MS),
    };

    session.timer.unref();
    this.#sessions.set(receipt.token, session);

    for (const entry of entries.filter((e) => e.directory))
      await mkdir(checkedPath(receipt.stage, entry.path), { recursive: true, mode: 0o700 });
  }

  #drop(token: string) {
    const session = this.#sessions.get(token);

    if (session) clearTimeout(session.timer);
    this.#sessions.delete(token);
  }

  /** The single-chunk write of gateways before workspace_copy_batch_v3. */
  write(chunk: WorkspaceCopyChunk) {
    return this.#write(this.#session(chunk.token), chunk);
  }

  /** One frame of whole files and pieces, written side by side; every path at most once. */
  async writeBatch(batch: WorkspaceCopyBatch) {
    const session = this.#session(batch.token);
    const paths = new Set(batch.chunks.map((c) => c.path));

    if (
      batch.chunks.length > COPY_FRAME_FILES ||
      paths.size !== batch.chunks.length ||
      batch.chunks.some((c) => c.token !== batch.token) ||
      batch.chunks.reduce((sum, c) => sum + c.data.length, 0) > COPY_FRAME_BYTES
    )
      throw copyError("Unexpected transfer chunk.");
    await mapLimit(batch.chunks, WRITE_CONCURRENCY, (chunk) => this.#write(session, chunk));
  }

  #session(token: string) {
    const session = this.#sessions.get(token);

    if (!session) throw copyError("The transfer expired. Retry the copy.");
    session.timer.refresh();

    return session;
  }

  async #write(session: TargetSession, chunk: WorkspaceCopyChunk) {
    const entry = session.entries.get(chunk.path);

    if (!entry || entry.directory || session.done.has(entry.path) || chunk.data.length > COPY_FRAME_BYTES)
      throw copyError("Unexpected transfer chunk.");

    if (chunk.unchanged) {
      if (chunk.offset !== 0n || !chunk.sha256 || session.staged.get(entry.path) !== chunk.sha256)
        throw copyError("File integrity check failed. Retry the copy.");
      session.staged.delete(entry.path);
      session.done.set(entry.path, chunk.sha256);

      return;
    }

    const first = chunk.offset === 0n;
    const writing = first ? { offset: 0, hash: createHash("sha256") } : session.writing.get(entry.path);

    if (
      !writing ||
      BigInt(writing.offset) !== chunk.offset ||
      chunk.offset + BigInt(chunk.data.length) > entry.size ||
      (chunk.data.length === 0 && !chunk.last)
    )
      throw copyError("The transfer lost its place. Retry the copy.");
    // Claimed before any await: a second piece of the same file cannot pass the offset check meanwhile.
    session.writing.delete(entry.path);
    session.staged.delete(entry.path);
    await writePiece(session.receipt.stage, entry, chunk, session.dirs);
    writing.hash.update(chunk.data);
    writing.offset += chunk.data.length;

    if (!chunk.last) {
      session.writing.set(entry.path, writing);

      return;
    }

    const hash = writing.hash.digest("hex");

    if (BigInt(writing.offset) !== entry.size || hash !== chunk.sha256)
      throw copyError("File integrity check failed. Retry the copy.");
    await settle(session.receipt.stage, entry);
    session.done.set(entry.path, hash);
  }

  async finish(request: WorkspaceCopyFinish) {
    await this.ready;
    const session = this.#sessions.get(request.token);
    const receipt = session?.receipt ?? (await this.receipts.load(request.token));

    if (receipt?.state === "committed") {
      if (receipt.digest !== request.sha256) throw copyError("Transfer integrity check failed.");

      if (!(await sameIdentity(receipt.target, receipt.stageDev, receipt.stageIno)))
        throw copyError("The copied directory changed. Choose another destination.");

      return receipt.target;
    }

    const files = session && [...session.entries.values()].filter((e) => !e.directory);

    if (!session || !receipt || !files || files.some((e) => !session.done.has(e.path)))
      throw copyError("The transfer is incomplete. Retry the copy.");
    const total = createHash("sha256");

    for (const e of files) total.update(`${e.path}\0${e.size}\0${session.done.get(e.path)}\n`);

    if (total.digest("hex") !== request.sha256) {
      await this.cancel(request.token);
      throw copyError("Transfer integrity check failed. Retry the copy.");
    }

    await this.#publish(session, receipt, request.sha256);

    return receipt.target;
  }

  async #publish(session: TargetSession, receipt: CopyReceipt, digest: string) {
    await syncFiles(receipt.stage, session.entries.values());
    await rebuildCopyGitMetadata(receipt.stage, [...session.entries.keys()]);
    const valid = await freshGit(() => git(receipt.stage, ["fsck", "--connectivity-only", "--no-reflogs"]));

    if (!valid.ok) throw copyError("The copied Git metadata is incomplete. Refresh the file list and retry.");

    for (const entry of [...session.entries.values()]
      .filter((e) => e.directory)
      .sort((a, b) => b.path.length - a.path.length))
      if (!entry.path.startsWith(".git/")) await chmod(checkedPath(receipt.stage, entry.path), entry.mode & 0o777);

    if (
      (await realpath(receipt.parent)) !== receipt.parent ||
      !(await sameIdentity(receipt.target, receipt.targetDev, receipt.targetIno)) ||
      !(await sameIdentity(receipt.stage, receipt.stageDev, receipt.stageIno))
    )
      throw copyError("The destination changed while copying. Choose another directory.");
    receipt.state = "committing";
    receipt.digest = digest;
    await this.receipts.save(receipt);

    // Windows cannot rename a directory over an existing directory, even when it is empty.
    if (process.platform === "win32") await rmdir(receipt.target);
    await rename(receipt.stage, receipt.target);
    await syncDirectory(receipt.parent);
    receipt.state = "committed";
    await this.receipts.save(receipt);
    this.#drop(receipt.token);
  }

  async cancel(token: string) {
    await this.ready;
    const session = this.#sessions.get(token);
    this.#drop(token);
    const receipt = session?.receipt ?? (await this.receipts.load(token));

    if (receipt && receipt.state !== "committed") {
      if (receipt.state === "committing" && (await sameIdentity(receipt.target, receipt.stageDev, receipt.stageIno)))
        await this.receipts.save({ ...receipt, state: "committed" });
      else await this.receipts.clean(receipt);
    }
  }

  /** Shutdown keeps staged files: the transfer continues after the restart. */
  async close() {
    await this.ready;

    for (const token of this.#sessions.keys()) this.#drop(token);
  }
}
