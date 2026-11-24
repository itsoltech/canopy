import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { create } from "@bufbuild/protobuf";
import { ThreadSecretReceiptSchema, type ThreadSecretDelivery, type ThreadSecretReceipt } from "@canopy/contracts";

import { projectSecretGuard, projectSecretValues, redactSecretText, secretPatterns } from "./project-secret-guard.ts";
import { ProjectSecretTurns } from "./project-secret-turns.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeStores = new Set<ThreadSecretFiles>();

export function threadSecretRedactionValues(threadId?: string): string[] {
  return [...activeStores].flatMap((store) => store.redactionValues(threadId));
}

/** Provider output masking for both manual and project secrets scoped to the current thread. */
export function threadSecretOutputGuard(threadId: string) {
  const values = () => [...threadSecretRedactionValues(threadId), ...projectSecretValues(threadId)];

  return {
    hasValues: () => values().length > 0,
    redact: (text: string) => redactSecretText(text, secretPatterns(values())),
  };
}

interface SecretFile {
  readonly expires: number;
  readonly revision: number;
  readonly file: string;
  readonly threadId: string;
  readonly turnId: string;
  revoked: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Private materializations, never inside the workspace or the provider's environment. */
export class ThreadSecretFiles {
  readonly root: string;
  // A process can still emit a value after its file expires or its thread closes.
  readonly #redactions = new Map<string, Set<string>>();
  readonly #closed = new Set<string>();
  readonly #entries = new Map<string, SecretFile>();
  readonly #turns = new ProjectSecretTurns((threadId, turnId) => this.#removeProjectFiles(threadId, turnId));
  readonly #projectThreads = new Set<string>();
  #projectTurnsDisabled = false;
  constructor(dataDir: string) {
    this.root = join(resolve(dataDir), "thread-secrets");
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });

    if (existsSync(this.root)) {
      if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory())
        throw new Error("unsafe thread secrets directory");
      // A fresh process has no grants yet. The gateway re-delivers only unexpired values.
      rmSync(this.root, { recursive: true, force: true });
    }

    mkdirSync(this.root, { mode: 0o700 });
    chmodSync(this.root, 0o700);
    activeStores.add(this);
  }
  threadDir(threadId: string): string {
    if (!UUID.test(threadId)) throw new Error("invalid thread secret owner");
    const dir = join(this.root, threadId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())
      throw new Error("unsafe thread secrets directory");
    chmodSync(dir, 0o700);

    return dir;
  }
  redactionValues(threadId?: string): string[] {
    if (threadId) return [...(this.#redactions.get(threadId) ?? [])];

    return [...new Set([...this.#redactions.values()].flatMap((values) => [...values]))];
  }
  #rememberManualValue(threadId: string, value: string): void {
    const values = this.#redactions.get(threadId) ?? new Set<string>();
    values.add(value);
    this.#redactions.set(threadId, values);
  }
  apply(delivery: ThreadSecretDelivery, beforeProjectWrite?: () => boolean): ThreadSecretReceipt {
    const receipt = create(ThreadSecretReceiptSchema, {
      requestId: delivery.requestId,
      threadId: delivery.threadId,
      revision: delivery.revision,
      turnId: delivery.turnId,
      rejected: Boolean(delivery.turnId),
    });

    try {
      if (!UUID.test(delivery.requestId) || !UUID.test(delivery.threadId) || delivery.revision < 1) return receipt;
      const key = `${delivery.threadId}/${delivery.requestId}`;
      const previous = this.#entries.get(key);

      if (previous && (previous.revision > delivery.revision || previous.turnId !== delivery.turnId)) return receipt;
      const expires = delivery.expiresAt ? timestampDate(delivery.expiresAt).getTime() : 0;
      const project = Boolean(delivery.turnId);
      const eligible = this.projectTurnSignal(delivery.threadId, delivery.turnId);
      const retired = previous && (previous.revoked || previous.expires <= Date.now());

      if (
        !delivery.remove &&
        project &&
        (!eligible || retired || !Number.isFinite(expires) || expires <= Date.now() || !delivery.value)
      )
        return receipt;

      if (this.#closed.has(delivery.threadId) && !delivery.remove && expires > Date.now()) return receipt;
      const directory = join(this.root, delivery.threadId);

      if (existsSync(directory)) this.threadDir(delivery.threadId);
      const file = join(directory, delivery.requestId);

      const entry = {
        expires,
        revision: delivery.revision,
        file,
        threadId: delivery.threadId,
        turnId: delivery.turnId,
        revoked: false,
      };

      if (delivery.remove || expires <= Date.now()) {
        rmSync(file, { force: true });

        if (previous?.timer) clearTimeout(previous.timer);
        this.#entries.delete(key);

        if (!project || eligible) this.#entries.set(key, { ...entry, revoked: true });
        receipt.applied = true;
        receipt.rejected = false;

        return receipt;
      }

      if (!delivery.cwd) return receipt;
      const cwd = existsSync(delivery.cwd) ? realpathSync(delivery.cwd) : resolve(delivery.cwd);
      const within = relative(cwd, realpathSync(this.root));

      if (
        !within ||
        (!within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && within !== ".." && !isAbsolute(within))
      )
        return receipt;

      if (previous?.revision === delivery.revision) {
        if (existsSync(file)) {
          receipt.applied = true;
          receipt.rejected = false;
          receipt.file = file;

          return receipt;
        }
      }

      if (project && beforeProjectWrite && !beforeProjectWrite()) return receipt;
      const dir = this.threadDir(delivery.threadId);
      const partial = join(dir, `${delivery.requestId}.${crypto.randomUUID()}.partial`);

      const fd = openSync(
        partial,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );

      try {
        try {
          writeFileSync(fd, delivery.value, "utf8");
        } finally {
          closeSync(fd);
        }

        renameSync(partial, file);
      } finally {
        rmSync(partial, { force: true });
      }

      if (previous?.timer) clearTimeout(previous.timer);

      const timer = setTimeout(
        () => this.#removeEntry(key, true),
        Math.max(0, Math.min(expires - Date.now(), 2_147_483_647)),
      ).unref();

      if (project) this.#turns.add(delivery.threadId, delivery.turnId, delivery.value, file, delivery.requestId);
      else if (delivery.value) this.#rememberManualValue(delivery.threadId, delivery.value);
      this.#entries.set(key, { ...entry, timer });
      receipt.applied = true;
      receipt.rejected = false;
      receipt.file = file;
    } catch {
      /* Do not attach a delivery, its value, or an exception to diagnostics. */
    }

    return receipt;
  }
  beginProjectTurn(threadId: string, turnId: string): void {
    if (this.#projectTurnsDisabled || !UUID.test(threadId) || !turnId || this.#closed.has(threadId)) return;
    this.#projectThreads.add(threadId);
    this.#turns.begin(threadId, turnId);
  }

  projectTurnSignal(threadId: string, turnId: string): AbortSignal | undefined {
    return this.#closed.has(threadId) ? undefined : this.#turns.signal(threadId, turnId);
  }

  requestProjectTurnSignal(threadId: string, turnId: string): AbortSignal | undefined {
    return this.#closed.has(threadId) ? undefined : this.#turns.requestSignal(threadId, turnId);
  }

  projectFileAvailable(threadId: string, turnId: string, file: string): boolean {
    if (!this.projectTurnSignal(threadId, turnId)) return false;

    return [...this.#entries.values()].some(
      (entry) =>
        entry.file === file &&
        entry.threadId === threadId &&
        entry.turnId === turnId &&
        !entry.revoked &&
        entry.expires > Date.now() &&
        existsSync(entry.file),
    );
  }

  fenceProjectTurn(threadId: string, turnId: string): void {
    this.#turns.fence(threadId, turnId);
  }

  fenceProjectTurns(): void {
    this.#turns.fenceAll();
  }

  disableProjectTurns(): void {
    this.#projectTurnsDisabled = true;
    this.fenceProjectTurns();
  }

  finishProjectTurn(threadId: string, turnId: string): void {
    this.#turns.finish(threadId, turnId);
  }

  trackProjectBackground(threadId: string, turnId: string, itemId: string, running: boolean): void {
    this.#turns.background(threadId, turnId, itemId, running);
  }

  #removeProjectFiles(threadId: string, turnId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.threadId === threadId && entry.turnId === turnId) this.#removeEntry(key, false);
    }
  }

  #removeEntry(key: string, keepRevision: boolean): void {
    const entry = this.#entries.get(key);

    if (!entry) return;
    entry.revoked = true;

    if (entry.timer) clearTimeout(entry.timer);
    delete entry.timer;

    try {
      rmSync(entry.file, { force: true });

      if (!keepRevision) this.#entries.delete(key);
    } catch {
      entry.timer = setTimeout(() => this.#removeEntry(key, keepRevision), 1_000).unref();
    }
  }

  closeThread(threadId: string): void {
    if (!UUID.test(threadId)) throw new Error("invalid thread secret owner");
    this.#closed.add(threadId);
    projectSecretGuard(threadId).reset();
    this.#turns.finishThread(threadId);
    this.#projectThreads.delete(threadId);

    for (const [key, entry] of this.#entries) {
      if (entry.threadId !== threadId) continue;

      if (entry.turnId) this.#removeEntry(key, false);
      else if (entry.timer) {
        clearTimeout(entry.timer);
        delete entry.timer;
      }
    }

    rmSync(join(this.root, threadId), { recursive: true, force: true });
  }
  openThread(threadId: string): void {
    if (!UUID.test(threadId)) throw new Error("invalid thread secret owner");
    this.#closed.delete(threadId);
  }
  close(): void {
    activeStores.delete(this);
    this.#turns.close();

    for (const threadId of this.#projectThreads) projectSecretGuard(threadId).reset();
    this.#projectThreads.clear();

    for (const entry of this.#entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.#entries.clear();
    this.#redactions.clear();
    this.#closed.clear();

    for (const name of readdirSync(this.root)) rmSync(join(this.root, name), { recursive: true, force: true });
  }
}
