import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { create } from "@bufbuild/protobuf";
import { ThreadSecretReceiptSchema, type ThreadSecretDelivery, type ThreadSecretReceipt } from "@canopy/contracts";

import { projectSecretGuard, projectSecretValues, redactSecretText, secretPatterns } from "./project-secret-guard.ts";
import { ProjectSecretTurns } from "./project-secret-turns.ts";
import { loginRedactionValues } from "./project-login-values.ts";
import { isWithin } from "../git/worktrees.ts";
import { canonicalPath } from "../git/checkout-paths.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeStores = new Set<ThreadSecretFiles>();

// Output a harness already produced can arrive after the browser session closed.
const BROWSER_OUTPUT_DRAIN_MS = 30_000;

export function threadSecretRedactionValues(threadId?: string): string[] {
  return [...activeStores].flatMap((store) => store.redactionValues(threadId));
}

/** Values entered into this thread's browser: masked in its own output only. */
export function threadBrowserValues(threadId: string): string[] {
  return [...activeStores].flatMap((store) => store.browserValues(threadId));
}

/** Provider output masking for both manual and project secrets scoped to the current thread. */
export function threadSecretOutputGuard(threadId: string) {
  const values = () => [
    ...threadSecretRedactionValues(threadId),
    ...projectSecretValues(threadId),
    ...threadBrowserValues(threadId),
  ];

  return {
    hasValues: () => values().length > 0,
    redact: (text: string) => redactSecretText(text, secretPatterns(values())),
  };
}

interface BrowserValues {
  current: Set<string>;
  readonly closing: Set<{ values: Set<string>; timer: ReturnType<typeof setTimeout> }>;
}

interface SecretFile {
  readonly expires: number;
  readonly revision: number;
  readonly file: string;
  readonly threadId: string;
  readonly turnId: string;
  /** A browser login lease: the value lives only here, never in a file, and is dropped on removal. */
  memory?: string;
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
  readonly #browser = new Map<string, BrowserValues>();
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
  apply(
    delivery: ThreadSecretDelivery,
    beforeProjectWrite?: () => boolean,
    ...localWorkspaces: (string | undefined)[]
  ): ThreadSecretReceipt {
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

      const eligible = delivery.memoryOnly
        ? this.#memoryTurnSignal(delivery.threadId, delivery.turnId)
        : this.projectTurnSignal(delivery.threadId, delivery.turnId);

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

      if (delivery.memoryOnly) return this.#applyMemory(key, delivery, entry, receipt, beforeProjectWrite);

      if (!delivery.cwd) return receipt;
      const root = realpathSync(this.root);

      // A worktree switch can leave the current harness in the previous cwd until the next turn.
      for (const cwd of new Set([delivery.cwd, ...localWorkspaces])) {
        if (!cwd) continue;
        const workspace = canonicalPath(cwd);

        if (isWithin(workspace, root) || isWithin(root, workspace)) return receipt;
      }

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

      if (project) {
        this.#turns.add(delivery.threadId, delivery.turnId, delivery.value, file, delivery.requestId);

        // A login file is JSON: its password and other parts can appear on their own in output.
        for (const value of delivery.login ? loginRedactionValues(delivery.value) : [])
          this.#turns.add(delivery.threadId, delivery.turnId, value);
      } else if (delivery.value) this.#rememberManualValue(delivery.threadId, delivery.value);
      this.#entries.set(key, { ...entry, timer });
      receipt.applied = true;
      receipt.rejected = false;
      receipt.file = file;
    } catch {
      /* Do not attach a delivery, its value, or an exception to diagnostics. */
    }

    return receipt;
  }
  #applyMemory(
    key: string,
    delivery: ThreadSecretDelivery,
    entry: SecretFile,
    receipt: ThreadSecretReceipt,
    beforeProjectWrite?: () => boolean,
  ): ThreadSecretReceipt {
    const values = loginRedactionValues(delivery.value);

    if (!delivery.turnId || !values.length || (beforeProjectWrite && !beforeProjectWrite())) return receipt;
    const previous = this.#entries.get(key);

    if (previous?.timer) clearTimeout(previous.timer);

    const timer = setTimeout(
      () => this.#removeEntry(key, true),
      Math.max(0, Math.min(entry.expires - Date.now(), 2_147_483_647)),
    ).unref();

    for (const value of values)
      this.#turns.add(delivery.threadId, delivery.turnId, value, undefined, delivery.requestId);
    this.#entries.set(key, { ...entry, file: "", memory: delivery.value, timer });
    receipt.applied = true;
    receipt.rejected = false;

    return receipt;
  }

  /** A browser login lease of the running turn, read by Agent Browser only. */
  readProjectLogin(threadId: string, turnId: string, requestId: string): string | undefined {
    if (!UUID.test(threadId) || !UUID.test(requestId) || !this.#memoryTurnSignal(threadId, turnId)) return;
    const entry = this.#entries.get(`${threadId}/${requestId}`);

    if (!entry?.memory || entry.turnId !== turnId || entry.revoked || entry.expires <= Date.now()) return;

    return entry.memory;
  }

  /** Values entered into this thread's browser stay masked after the lease ends: the page can still hold them. */
  rememberBrowserValues(threadId: string, values: readonly string[]): void {
    if (!UUID.test(threadId) || this.#closed.has(threadId)) return;
    const known = this.#browser.get(threadId) ?? { current: new Set<string>(), closing: new Set() };

    for (const value of values) if (value) known.current.add(value);
    this.#browser.set(threadId, known);
  }

  /**
   * The browser session ended. Its values stay masked for output already on its way, then go; a session
   * opened meanwhile keeps its own.
   */
  forgetBrowserValues(threadId: string): void {
    const known = this.#browser.get(threadId);

    if (!known?.current.size) return;

    const closing = {
      values: known.current,
      timer: setTimeout(() => known.closing.delete(closing), BROWSER_OUTPUT_DRAIN_MS).unref(),
    };

    known.current = new Set();
    known.closing.add(closing);
  }

  browserValues(threadId: string): string[] {
    const known = this.#browser.get(threadId);

    if (!known) return [];

    return [...new Set([...known.current, ...[...known.closing].flatMap((closing) => [...closing.values])])];
  }

  beginProjectTurn(threadId: string, turnId: string): void {
    if (this.#projectTurnsDisabled || !UUID.test(threadId) || !turnId || this.#closed.has(threadId)) return;
    this.#projectThreads.add(threadId);
    this.#turns.begin(threadId, turnId);
  }

  projectTurnSignal(threadId: string, turnId: string): AbortSignal | undefined {
    return this.#closed.has(threadId) ? undefined : this.#turns.signal(threadId, turnId);
  }

  #memoryTurnSignal(threadId: string, turnId: string): AbortSignal | undefined {
    return this.#closed.has(threadId) ? undefined : this.#turns.memorySignal(threadId, turnId);
  }

  requestProjectTurnSignal(threadId: string, turnId: string): AbortSignal | undefined {
    return this.#closed.has(threadId) ? undefined : this.#turns.requestSignal(threadId, turnId);
  }

  projectFileAvailable(threadId: string, turnId: string, file: string): boolean {
    if (!this.projectTurnSignal(threadId, turnId)) return false;

    return [...this.#entries.values()].some(
      (entry) =>
        Boolean(entry.file) &&
        entry.file === file &&
        entry.threadId === threadId &&
        entry.turnId === turnId &&
        !entry.revoked &&
        entry.expires > Date.now() &&
        existsSync(entry.file),
    );
  }

  readManualSecret(threadId: string, requestId: string): string | undefined {
    if (!UUID.test(threadId) || !UUID.test(requestId) || this.#closed.has(threadId)) return;
    const entry = this.#entries.get(`${threadId}/${requestId}`);

    if (!entry || entry.turnId || entry.revoked || entry.expires <= Date.now()) return;

    try {
      const fd = openSync(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

      try {
        const stat = fstatSync(fd);

        if (stat.isFile() && stat.size <= 32768) return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      // The secret may have been removed or replaced before it was read.
    }

    return undefined;
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
    delete entry.memory;

    if (entry.timer) clearTimeout(entry.timer);
    delete entry.timer;

    try {
      if (entry.file) rmSync(entry.file, { force: true });

      if (!keepRevision) this.#entries.delete(key);
    } catch {
      entry.timer = setTimeout(() => this.#removeEntry(key, keepRevision), 1_000).unref();
    }
  }

  closeThread(threadId: string): void {
    if (!UUID.test(threadId)) throw new Error("invalid thread secret owner");
    this.#closed.add(threadId);
    this.forgetBrowserValues(threadId);
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

    for (const known of this.#browser.values()) for (const closing of known.closing) clearTimeout(closing.timer);
    this.#browser.clear();
    this.#closed.clear();

    for (const name of readdirSync(this.root)) rmSync(join(this.root, name), { recursive: true, force: true });
  }
}
