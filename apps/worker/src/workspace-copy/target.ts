import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  WorkspaceCopyChunk,
  WorkspaceCopyEntry,
  WorkspaceCopyFinish,
  WorkspaceCopyPrepare,
} from "@canopy/contracts";
import {
  COPY_CHUNK_BYTES,
  COPY_MAX_BYTES,
  COPY_MAX_ENTRIES,
  COPY_MAX_FILE_BYTES,
  COPY_IDLE_MS,
  copyTotals,
} from "@canopy/domain/workspace-copy";
import { newDirectory } from "../git/project-sources.ts";
import { freshGit, git } from "../git/git.ts";
import { copyError, checkedPath, checkedParent, within, sameIdentity } from "./safety.ts";
import { CopyReceipts, type CopyReceipt } from "./receipts.ts";

interface TargetSession {
  receipt: CopyReceipt;
  entries: Map<string, WorkspaceCopyEntry>;
  remaining: Set<string>;
  total: Hash;
  received: number;
  expected: number;
  reading?: { path: string; offset: number; hash: Hash };
  timer: ReturnType<typeof setTimeout>;
}

export class CopyTargets {
  readonly #sessions = new Map<string, TargetSession>();
  readonly receipts: CopyReceipts;
  readonly ready: Promise<void>;
  constructor(dataDir: string) {
    this.receipts = new CopyReceipts(dataDir);
    this.ready = this.receipts.recover();
  }

  async prepare(request: WorkspaceCopyPrepare) {
    await this.ready;
    const old = await this.receipts.load(request.token);

    if (old?.state === "committed") {
      if (!(await sameIdentity(old.target, old.stageDev, old.stageIno)))
        throw copyError("The copied directory changed. Choose another destination.");

      return old.target;
    }

    if (old || this.#sessions.size >= 2) throw copyError("A copy is already in progress. Cancel it before retrying.");
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
    };

    try {
      await chmod(stage, 0o700);
      await this.receipts.save(receipt);
      const entries = new Map(request.entries.map((e) => [e.path, e]));
      const remaining = new Set(request.entries.filter((e) => !e.directory).map((e) => e.path));

      const session: TargetSession = {
        receipt,
        entries,
        remaining,
        total: createHash("sha256"),
        received: 0,
        expected: Number(request.bytes),
        timer: setTimeout(() => void this.cancel(request.token), COPY_IDLE_MS),
      };

      session.timer.unref();
      this.#sessions.set(request.token, session);

      for (const entry of request.entries.filter((e) => e.directory)) {
        const full = checkedPath(stage, entry.path);
        await mkdir(full, { recursive: true, mode: 0o700 });
      }

      return "";
    } catch (error) {
      await this.cancel(request.token);
      await this.receipts.clean(receipt);
      throw error;
    }
  }

  async write(chunk: WorkspaceCopyChunk) {
    const session = this.#sessions.get(chunk.token);

    if (!session) throw copyError("The transfer expired. Retry the copy.");
    session.timer.refresh();
    const entry = session.entries.get(chunk.path);

    if (!entry || entry.directory || !session.remaining.has(entry.path) || chunk.data.length > COPY_CHUNK_BYTES)
      throw copyError("Unexpected transfer chunk.");
    const reading = session.reading ?? { path: entry.path, offset: 0, hash: createHash("sha256") };

    if (
      reading.path !== entry.path ||
      BigInt(reading.offset) !== chunk.offset ||
      chunk.offset + BigInt(chunk.data.length) > entry.size ||
      (chunk.data.length === 0 && !chunk.last)
    )
      throw copyError("The transfer lost its place. Retry the copy.");
    session.reading = reading;
    const full = checkedPath(session.receipt.stage, entry.path);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await checkedParent(session.receipt.stage, full);

    if (entry.symlink) {
      if (!chunk.last || chunk.offset !== 0n || Buffer.from(chunk.data).toString() !== entry.symlink)
        throw copyError("Invalid symlink payload.");
    } else {
      const handle = await open(
        full,
        constants.O_WRONLY | constants.O_NOFOLLOW | (reading.offset === 0 ? constants.O_CREAT | constants.O_EXCL : 0),
        0o600,
      );

      try {
        let written = 0;

        while (written < chunk.data.length) {
          const result = await handle.write(chunk.data, written, chunk.data.length - written, reading.offset + written);

          if (!result.bytesWritten) throw copyError("The target disk could not accept the file.");
          written += result.bytesWritten;
        }

        if (chunk.last) await handle.sync();
      } finally {
        await handle.close();
      }
    }

    reading.hash.update(chunk.data);
    reading.offset += chunk.data.length;
    session.received += chunk.data.length;

    if (chunk.last) {
      const hash = reading.hash.digest("hex");

      if (BigInt(reading.offset) !== entry.size || hash !== chunk.sha256)
        throw copyError("File integrity check failed. Retry the copy.");

      if (entry.symlink) await symlink(entry.symlink, full);
      else await chmod(full, entry.mode & 0o777);
      session.total.update(`${entry.path}\0${entry.size}\0${hash}\n`);
      session.remaining.delete(entry.path);
      delete session.reading;
    }
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

    if (!session || !receipt || session.remaining.size || session.received !== session.expected)
      throw copyError("The transfer is incomplete. Retry the copy.");

    if (session.total.digest("hex") !== request.sha256)
      throw copyError("Transfer integrity check failed. Retry the copy.");

    const valid = await freshGit(() => git(receipt.stage, ["fsck", "--connectivity-only", "--no-reflogs"]));

    if (!valid.ok) throw copyError("The copied Git metadata is incomplete. Refresh the file list and retry.");

    for (const entry of [...session.entries.values()]
      .filter((e) => e.directory)
      .sort((a, b) => b.path.length - a.path.length))
      await chmod(checkedPath(receipt.stage, entry.path), entry.mode & 0o777);

    if (
      (await realpath(receipt.parent)) !== receipt.parent ||
      !(await sameIdentity(receipt.target, receipt.targetDev, receipt.targetIno)) ||
      !(await sameIdentity(receipt.stage, receipt.stageDev, receipt.stageIno))
    )
      throw copyError("The destination changed while copying. Choose another directory.");
    receipt.state = "committing";
    receipt.digest = request.sha256;
    await this.receipts.save(receipt);

    // Windows cannot rename a directory over an existing directory, even when it is empty.
    if (process.platform === "win32") await rmdir(receipt.target);
    await rename(receipt.stage, receipt.target);
    receipt.state = "committed";
    await this.receipts.save(receipt);
    clearTimeout(session.timer);
    this.#sessions.delete(request.token);

    return receipt.target;
  }

  async cancel(token: string) {
    await this.ready;
    const session = this.#sessions.get(token);

    if (session) clearTimeout(session.timer);
    this.#sessions.delete(token);
    const receipt = session?.receipt ?? (await this.receipts.load(token));

    if (receipt && receipt.state !== "committed") {
      if (receipt.state === "committing" && (await sameIdentity(receipt.target, receipt.stageDev, receipt.stageIno)))
        await this.receipts.save({ ...receipt, state: "committed" });
      else await this.receipts.clean(receipt);
    }
  }

  async close() {
    await this.ready;
    await Promise.all([...this.#sessions.keys()].map((token) => this.cancel(token)));
  }
}

function validateEntries(entries: readonly WorkspaceCopyEntry[], bytes: bigint) {
  if (entries.length > COPY_MAX_ENTRIES || bytes > COPY_MAX_BYTES || copyTotals(entries).bytes !== bytes)
    throw copyError("The selection exceeds the 20 GB copy limit.");
  const paths = new Set<string>();

  for (const e of entries) {
    checkedPath("/", e.path);

    if (e.blocked || e.size > COPY_MAX_FILE_BYTES)
      throw copyError("A selected file cannot be copied (8 GB per-file limit).");
    const key = e.path.toLowerCase();

    if (paths.has(key)) throw copyError("Two selected paths differ only in letter case.");
    paths.add(key);

    if (
      e.symlink &&
      (isAbsolute(e.symlink) ||
        e.symlink.includes("\\") ||
        !within("/copy", resolve("/copy", dirname(e.path), e.symlink)))
    )
      throw copyError("A symlink points outside the repository.");
  }

  const links = entries.filter((e) => e.symlink);

  if (entries.some((e) => links.some((link) => e.path.startsWith(`${link.path}/`))))
    throw copyError("A selected file is inside a symlink.");

  if (!entries.some((e) => e.path === ".git/HEAD") || !entries.some((e) => e.path === ".git/config"))
    throw copyError("Include the Git metadata to create a usable checkout.");
}
