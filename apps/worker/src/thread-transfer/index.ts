import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile as copyFileExclusive,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  open,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { create } from "@bufbuild/protobuf";
import {
  ThreadTransferPackageSchema,
  ThreadTransferResultSchema,
  ThreadTransferSessionSchema,
  ThreadTransferSummarySchema,
  type ThreadTransferExport,
  type ThreadTransferOperation,
  type ThreadTransferSession,
} from "@canopy/contracts";
import { checkedParent, readHandle } from "../workspace-copy/safety.ts";
import { CommandError } from "../runtime/host-types.ts";
import {
  adoptionRecord,
  performAdoption,
  planAdoption,
  settleAdoption,
  undoAdoption,
  type AdoptionHome,
} from "./adopt.ts";
import {
  applyCheckout,
  dropTransferRef,
  exportCheckout,
  fetchCommits,
  inspectCheckout,
  plainPath,
  repositoryTips,
  verifyCheckout,
  type CheckoutExport,
} from "./checkout.ts";
import { transferError } from "./errors.ts";
import { packageEntries, PackageSources, PackageTargets, stagedPath } from "./package.ts";
import { checkSessionLayout, exportSessions, regularFiles, sessionFilesIn, type SessionLocator } from "./sessions.ts";

/**
 * Worker side of moving a thread to another worker (docs/thread-transfers.md): the source inspects and exports the
 * thread's checkout and harness sessions into a package, the target stages it, fetches its commits, recreates the
 * changes in the new worktree and adopts the sessions. Bytes never enter the journal, an outbox or a log.
 */

const TOKEN = z.uuid();

/** Packages and staging directories nobody released (the gateway lost the move) go after this long. */
const STALE_MS = 7 * 24 * 60 * 60_000;

/** The package's description: paths and hashes, never file content. */
const DESCRIPTION_BYTES = 32 * 1024 ** 2;

const description = z.object({
  version: z.literal(1),
  checkout: z.object({
    head: z.string(),
    branch: z.string(),
    bundle: z.boolean(),
    indexPatch: z.boolean(),
    worktreePatch: z.boolean(),
    files: z.array(z.string()),
    modes: z.record(z.string(), z.number()),
    tree: z.array(z.object({ path: z.string(), sha256: z.string() })),
    localFiles: z.array(z.string()),
    fingerprint: z.string(),
  }),
  sessions: z.array(
    z.object({ threadId: z.string(), provider: z.string(), providerThreadId: z.string(), files: z.array(z.string()) }),
  ),
});

type Description = z.infer<typeof description>;

/** A target's transfer: staged (commits fetched), then applied once; only a release or a cancel ends it. */
const targetState = z.object({
  repo: z.string(),
  phase: z.enum(["staged", "applying"]).default("staged"),
  adoptions: z.array(adoptionRecord),
});

export interface ThreadTransferHost {
  dataDir: string;
  locate: SessionLocator;
  /** The home and manifest a session of `profileId` is resumed from on this worker; refuses unsupported ones. */
  adoptionHome(session: ThreadTransferSession): Promise<AdoptionHome>;
  /** Binds a Codex session to a shared CLI home in the journal, and undoes exactly that binding. */
  bindCliHome(sessionId: string, home: string): Promise<void>;
  unbindCliHome(sessionId: string, home: string): Promise<void>;
  /** The journal's proof that a Codex session has history, so a missing rollout is never replaced by a new one. */
  codexHistory: {
    has(threadId: string, sessionId: string): Promise<boolean>;
    set(threadId: string, sessionId: string, present: boolean): Promise<void>;
  };
}

export class ThreadTransfers {
  readonly #sources = new PackageSources();
  readonly #targets = new PackageTargets();
  readonly #queues = new Map<string, Promise<void>>();
  #reconciled: Promise<void> | undefined;
  readonly #root: string;

  constructor(readonly host: ThreadTransferHost) {
    this.#root = join(host.dataDir, "thread-transfers");
  }

  #out = (token: string) => join(this.#root, "out", checked(token));
  #in = (token: string) => join(this.#root, "in", checked(token));

  /**
   * Operations of one transfer run one at a time (a cancel waits for an apply still running), and none before this
   * worker counted the staging left from before a restart.
   */
  execute(operation: ThreadTransferOperation) {
    const token = tokenOf(operation);

    if (!token) return this.reconcile().then(() => this.#execute(operation));

    const run = (this.#queues.get(token) ?? Promise.resolve())
      .then(() => this.reconcile())
      .then(() => this.#execute(operation));

    const settled = run.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(token, settled);
    void settled.then(() => {
      if (this.#queues.get(token) === settled) this.#queues.delete(token);
    });

    return run;
  }

  async #execute(operation: ThreadTransferOperation) {
    const action = operation.action;

    try {
      switch (action.case) {
        case "inspect": {
          const summary = await inspectCheckout(action.value.cwd);
          const missing = await this.#missingSessions(action.value.sessions);

          for (const session of action.value.sessions)
            if (!summary.blocked && (await this.host.locate.secretHistory(session)))
              summary.blocked =
                "This thread's history holds a project secret, so its session can't move to another worker.";

          return create(ThreadTransferResultSchema, {
            summary: create(ThreadTransferSummarySchema, { ...summary, missingSessions: missing }),
          });
        }

        case "export":
          return create(ThreadTransferResultSchema, { package: await this.#export(action.value) });
        case "readBatch":
          return create(ThreadTransferResultSchema, { batch: await this.#sources.readBatch(action.value) });
        case "release":
          await this.#release(action.value);
          break;
        case "tips":
          return create(ThreadTransferResultSchema, { tips: await repositoryTips(action.value.repoPath) });
        case "prepare":
          await this.#prepare(action.value.token, action.value.entries, action.value.bytes);
          break;
        case "writeBatch":
          await this.#targets.writeBatch(action.value);
          break;
        case "stage":
          return create(ThreadTransferResultSchema, await this.#stage(action.value));
        case "apply":
          return create(ThreadTransferResultSchema, {
            adopted: await this.#apply(action.value.token, action.value.cwd, action.value.sessions),
          });
        case "cancel":
          await this.#cancel(action.value);
          break;
        case "verify":
          await verifyCheckout(
            action.value.cwd,
            (await readDescription(join(this.#out(action.value.token), "transfer.json"))).checkout,
          );
          break;
        default:
          throw transferError("Choose a transfer operation.");
      }

      return create(ThreadTransferResultSchema);
    } catch (error) {
      // Filesystem and Git diagnostics can hold private paths; only refusals written for the owner pass through.
      if (error instanceof CommandError) throw error;
      throw transferError("Moving the thread failed on this worker. Try again.");
    }
  }

  async #missingSessions(sessions: readonly ThreadTransferSession[]) {
    const missing: string[] = [];
    const probe = join(this.#root, "probe", crypto.randomUUID());

    try {
      // A session with a project secret in its history is reported as such by inspect, not as missing.
      const plain = [];

      for (const session of sessions) if (!(await this.host.locate.secretHistory(session))) plain.push(session);
      const found = await exportSessions(plain, probe, this.host.locate, false);
      missing.push(...found.missing);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }

    return missing;
  }

  async #export(request: ThreadTransferExport) {
    const dir = this.#out(request.token);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });

    try {
      const checkout = await exportCheckout(request.cwd, dir, request, copyChecked);
      const sessions = await exportSessions(request.sessions, dir, this.host.locate);

      if (sessions.missing.length)
        throw transferError("A harness session of this thread is missing on its worker. It can't move.");
      const text: Description = { version: 1, checkout, sessions: sessions.exported };
      await writePrivate(join(dir, "transfer.json"), JSON.stringify(text));
      const { entries, files } = await packageEntries(dir);
      this.#sources.open(request.token, dir, files, entries);
      const bytes = entries.reduce((sum, e) => sum + e.size, 0n);

      return create(ThreadTransferPackageSchema, {
        token: request.token,
        entries,
        bytes,
        head: checkout.head,
        branch: checkout.branch,
      });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async #prepare(token: string, entries: Parameters<PackageTargets["prepare"]>[2], bytes: bigint) {
    const dir = this.#in(token);

    // A transfer that staged keeps its undo record until it is released or cancelled: never started over.
    if (await this.#state(token)) throw transferError("This move was already staged. Cancel it and start again.");
    await rm(dir, { recursive: true, force: true });
    await this.#targets.prepare(token, join(dir, "files"), entries, bytes);
  }

  async #stage(request: { token: string; sha256: string; repoPath: string }) {
    const stage = await this.#targets.complete(request.token, request.sha256);
    const parsed = await readDescription(stagedPath(stage, "transfer.json"));
    await this.#saveState(request.token, { repo: request.repoPath, phase: "staged", adoptions: [] });
    await fetchCommits(request.repoPath, stage, request.token, parsed.checkout.head, parsed.checkout.bundle);

    return { head: parsed.checkout.head, branch: parsed.checkout.branch };
  }

  async #apply(token: string, cwd: string, sessions: readonly ThreadTransferSession[]) {
    const stage = join(this.#in(token), "files");
    const parsed = await readDescription(join(stage, "transfer.json"));
    const state = await this.#state(token);

    if (!state) throw transferError("The transfer expired. Start the move again.");

    // Applied once: a failed apply is undone only by a cancel, which knows everything it changed.
    if (state.phase !== "staged") throw transferError("This move was already applied. Cancel it and start again.");

    // Exactly the requested sessions, each where its harness keeps it, before the checkout or a home changes.
    const pairs = sessions.map((session) => {
      const exported = parsed.sessions.find((e) => e.threadId === session.threadId);

      if (!exported || session.provider !== exported.provider || session.providerThreadId !== exported.providerThreadId)
        throw transferError("The moved sessions do not match the threads.");
      checkSessionLayout(exported);

      return { session, exported };
    });

    if (
      !pairs.length ||
      pairs.length !== parsed.sessions.length ||
      new Set(sessions.map((s) => s.threadId)).size !== sessions.length ||
      new Set(sessions.map((s) => `${s.provider}:${s.providerThreadId}`)).size !== sessions.length
    )
      throw transferError("The moved sessions do not match the threads.");
    state.phase = "applying";
    await this.#saveState(token, state);
    await applyCheckout(cwd, stage, parsed.checkout satisfies CheckoutExport, placeFile);

    for (const { session, exported } of pairs) {
      const home = await this.host.adoptionHome(session);
      const existing = await sessionFilesIn(home.home, exported.provider, exported.providerThreadId);
      const record = planAdoption(stage, token, exported, home, existing);
      record.history =
        exported.provider === "codex" &&
        !(await this.host.codexHistory.has(exported.threadId, exported.providerThreadId));
      // Saved before the first change: a cancel after a crash still knows what to undo.
      state.adoptions.push(record);
      await this.#saveState(token, state);

      // The binding and the history proof are part of what a cancel undoes (both are in the saved record).
      if (record.binding) await this.host.bindCliHome(record.session, record.binding);

      if (record.history) await this.host.codexHistory.set(exported.threadId, record.session, true);
      performAdoption(stage, exported, record);
      // Which manifest it wrote, so a late cancel never removes a newer move's.
      await this.#saveState(token, state);
    }

    return pairs.map(({ session }) => create(ThreadTransferSessionSchema, session));
  }

  async #release(token: string) {
    const out = this.#out(token);
    await this.#sources.release(token, out);
    const state = await this.#state(token);

    if (state) {
      await dropTransferRef(state.repo, token);

      for (const record of state.adoptions) settleAdoption(record);
    }

    this.#targets.forget(token);
    await rm(this.#in(token), { recursive: true, force: true });
  }

  async #cancel(token: string) {
    const state = await this.#state(token);

    if (state) {
      for (const record of state.adoptions.toReversed()) {
        undoAdoption(record);

        if (record.binding) await this.host.unbindCliHome(record.session, record.binding);

        if (record.history) await this.host.codexHistory.set(record.thread, record.session, false);
      }

      await dropTransferRef(state.repo, token);
    }

    this.#targets.forget(token);
    await rm(this.#in(token), { recursive: true, force: true });
  }

  /** The target's record; undefined only when there is none. One that can't be read is never taken as absent. */
  async #state(token: string) {
    let text: string;

    try {
      text = await readFile(join(this.#in(token), "state.json"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw transferError("This worker can't read the move's record. Try again.");
    }

    const parsed = targetState.safeParse(JSON.parse(text));

    if (!parsed.success) throw transferError("This worker can't read the move's record. Try again.");

    return parsed.data;
  }

  #saveState(token: string, state: z.infer<typeof targetState>) {
    return writePrivate(join(this.#in(token), "state.json"), JSON.stringify(state));
  }

  /**
   * Packages and staging the gateway never released (it lost the move): deleted after a week. Staging with adopted
   * sessions stays until the gateway releases or cancels it.
   */
  async sweep(now = Date.now()) {
    for (const side of ["out", "in", "probe"]) {
      const dir = join(this.#root, side);

      for (const name of await readdir(dir).catch(() => [])) {
        const info = await stat(join(dir, name)).catch(() => undefined);

        if (!info || now - info.mtimeMs <= (side === "probe" ? 0 : STALE_MS)) continue;

        if (side !== "in" || !TOKEN.safeParse(name).success) {
          await rm(join(dir, name), { recursive: true, force: true });
          continue;
        }

        // Adopted sessions wait for the gateway's release or cancel: only it knows whether the move happened. A
        // record that can't be read is kept too.
        const state = await this.#state(name).then(
          (found) => found ?? { adoptions: [] },
          () => undefined,
        );

        if (state && !state.adoptions.length) await this.#release(name);
      }
    }
  }

  /** At start: old packages go and the staging left on disk counts against capacity again. Retried until it works. */
  reconcile(): Promise<void> {
    this.#reconciled ??= (async () => {
      await this.sweep();
      const root = join(this.#root, "in");

      // No staging root yet is fine; any other failure to read it retries the whole reconciliation.
      const names = await readdir(root).catch((error: Error) => {
        if ("code" in error && error.code === "ENOENT") return [];
        throw error;
      });

      for (const name of names) {
        if (!TOKEN.safeParse(name).success) continue;
        let bytes = 0n;

        for (const file of await regularFiles(join(root, name))) bytes += BigInt((await stat(file)).size);
        this.#targets.hold(name, bytes);
      }
    })().catch(() => {
      this.#reconciled = undefined;
      throw transferError("This worker is still checking earlier moves. Try again in a moment.");
    });

    return this.#reconciled;
  }
}

async function readDescription(path: string): Promise<Description> {
  if ((await stat(path)).size > DESCRIPTION_BYTES) throw transferError("The transfer package is not valid.");

  return description.parse(JSON.parse(await readFile(path, "utf8")));
}

function tokenOf(operation: ThreadTransferOperation): string | undefined {
  const action = operation.action;

  switch (action.case) {
    case "export":
    case "prepare":
    case "stage":
    case "apply":
    case "writeBatch":
    case "readBatch":
    case "verify":
      return action.value.token;
    case "release":
    case "cancel":
      return action.value;
    default:
      return undefined;
  }
}

function checked(token: string) {
  if (!TOKEN.safeParse(token).success) throw transferError("Invalid transfer identifier.");

  return token;
}

async function writePrivate(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(`${path}.part`, "w", 0o600);

  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(`${path}.part`, path);
}

/** A checkout file into the package: no link is followed, in the file or its folders. */
async function copyChecked(root: string, path: string, destination: string) {
  const { handle } = await readHandle(root, path);

  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  } catch (error) {
    await handle.close();
    throw error;
  }

  // The read stream closes the handle when it ends or fails.
  await pipeline(handle.createReadStream(), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}

/** A package file into the new checkout; an existing file there (or a link on the way) refuses the move. */
async function placeFile(from: string, root: string, path: string, mode: number) {
  const destination = await plainPath(root, path, true);
  await checkedParent(root, destination);

  try {
    await copyFileExclusive(from, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw transferError("A moved file already exists in the new checkout.");
    throw error;
  }

  await chmod(destination, mode & 0o777);
}
