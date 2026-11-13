import { fileLocation } from "./file-references.ts";
import { restoreWorkspace, workspaceMetadata } from "./workspace-storage.ts";
import {
  WorkspaceFile,
  WorkspaceAccessRevoked,
  type WorkspaceFileApi,
  type WorkspaceFileTarget,
} from "./workspace-file.ts";
import { DirectoryQueue } from "./workspace-directory-queue.ts";
import { workspaceRead } from "./workspace-read.ts";
import {
  fileTab,
  tabBusy,
  tabDirty,
  type WorkspaceEntry,
  type WorkspaceModuleTarget,
  type WorkspaceTab,
} from "./workspace-modules.ts";

export type { WorkspaceEntry, WorkspaceTab } from "./workspace-modules.ts";

export const WORKSPACE_TAB_LIMIT = 12;
const DRAFT_BYTES = 4 * 1024 * 1024;

/** One thread's tab model. Thread is implicit and always first; focus never follows storage events. */
export class Workspace {
  tabs: WorkspaceEntry[] = [];
  active = "thread";
  sidebar: WorkspaceModuleTarget | undefined;
  panelCollapsed = false;
  panelWidth = 288;
  error = "";
  #recent: string[] = [];
  #next = 0;
  #metadata = new Map<string, string>();

  constructor(
    readonly threadId: string,
    readonly store: WorkspaceStore,
  ) {}

  get current(): WorkspaceEntry | undefined {
    return this.tabs.find((tab) => tab.id === this.active);
  }
  get currentFile(): WorkspaceTab | undefined {
    const current = this.current;

    return current?.kind === "file" ? current : undefined;
  }
  get files(): WorkspaceTab[] {
    return this.tabs.filter(fileTab);
  }
  get dirty(): WorkspaceTab[] {
    return this.files.filter((tab) => tab.document.dirty);
  }

  openModule(target: WorkspaceModuleTarget): void {
    const existing = this.tabs.find(
      (tab) => tab.kind === "module" && tab.module === target.module && tab.resource === target.resource,
    );

    if (existing) return this.select(existing.id);

    if (this.tabs.length >= WORKSPACE_TAB_LIMIT - 1) {
      this.error = "You have 12 open tabs. Close a tab, then open the module.";
      this.store.notify();

      return;
    }

    const id = `module-${++this.#next}`;
    this.tabs = [...this.tabs, { ...target, kind: "module", id, preview: false }];
    this.select(id);
  }

  setSidebar(target?: WorkspaceModuleTarget): void {
    this.sidebar = target;
    this.panelCollapsed = false;
    this.store.notify(true);
  }

  collapsePanel(collapsed: boolean): void {
    this.panelCollapsed = collapsed;
    this.store.notify(true);
  }

  sizePanel(width: number): void {
    this.panelWidth = Math.max(256, Math.min(384, width));
    this.store.notify(true);
  }

  open(target: WorkspaceFileTarget): void {
    const location = fileLocation(target.path);
    const next = { ...target, ...location };

    const existing = this.files.find(
      (tab) =>
        tab.document.target.threadId === target.threadId &&
        (tab.document.path === next.path ||
          tab.document.target.path === next.path ||
          tab.document.file?.relativePath === next.path),
    );

    if (existing) {
      existing.document.locate(next.position);
      this.select(existing.id);

      return;
    }

    const preview = this.files.find((tab) => tab.preview && !tab.document.dirty && !tab.document.busy);

    if (!preview && this.tabs.length >= WORKSPACE_TAB_LIMIT - 1) {
      this.error = "You have 12 open tabs. Close a tab, then open the file.";
      this.store.notify();

      return;
    }

    if (preview) this.close(preview.id);
    const id = `file-${++this.#next}`;

    const document: WorkspaceFile = new WorkspaceFile(
      next,
      this.store.api,
      () => this.documentChanged(id),
      (bytes): boolean => this.store.reserveDraft(document, bytes),
    );

    this.tabs = [...this.tabs, { kind: "file", id, document, preview: true }];
    this.select(id);
  }

  select(id: string): void {
    if (id !== "thread" && !this.tabs.some((tab) => tab.id === id)) return;

    if (this.active !== id) this.currentFile?.document.cancel();
    this.active = id;
    this.error = "";
    this.#recent = [id, ...this.#recent.filter((key) => key !== id)];
    this.store.touch(this);
    this.store.notify(true);
  }

  keep(id: string): void {
    const tab = this.tabs.find((tab) => tab.id === id);

    if (!tab || !tab.preview) return;
    tab.preview = false;
    this.store.notify(true);
  }

  move(id: string, delta: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    const tab = this.tabs[index];
    const to = Math.max(0, Math.min(this.tabs.length - 1, index + delta));

    if (!tab || index === to) return;
    this.keep(id);
    const tabs = [...this.tabs];
    tabs.splice(index, 1);
    tabs.splice(to, 0, tab);
    this.tabs = tabs;
    this.store.notify(true);
  }

  close(id: string): boolean {
    const tab = this.tabs.find((tab) => tab.id === id);

    if (!tab || tabDirty(tab) || tabBusy(tab)) return false;

    if (tab.kind === "file") tab.document.dispose();
    // The remaining documents retain their draft and scroll state.
    this.tabs = this.tabs.filter((entry) => entry.id !== id);
    this.#metadata.delete(id);
    this.#recent = this.#recent.filter((key) => key !== id);

    if (this.active === id)
      this.active = this.#recent.find((key) => key === "thread" || this.tabs.some((tab) => tab.id === key)) ?? "thread";
    this.store.notify(true);

    return true;
  }

  private documentChanged(id: string): void {
    const tab = this.files.find((tab) => tab.id === id);

    if (!tab) return;

    if (tab.document.editing) tab.preview = false;

    const duplicate = this.files.find(
      (other) =>
        other !== tab &&
        other.document.target.threadId === tab.document.target.threadId &&
        other.document.path === tab.document.path,
    );

    if (duplicate && !tab.document.dirty && !tab.document.busy) {
      this.close(id);
      duplicate.document.locate(tab.document.position);
      this.select(duplicate.id);

      return;
    }

    const signature = `${tab.preview}:${tab.document.path}`;
    const persist = this.#metadata.get(id) !== signature;
    this.#metadata.set(id, signature);
    this.store.trim();
    this.store.notify(persist);
  }
}

/** Bounded per-device store, separate from transcript warming. Persist callbacks receive metadata only. */
export class WorkspaceStore {
  readonly api: WorkspaceFileApi;
  readonly #fileListeners = new Set<(change: { threadId: string; path: string; revoked?: boolean } | null) => void>();
  readonly views = new Map<string, Workspace>();
  #listeners = new Set<() => void>();
  #version = 0;
  #persist: ((raw: string) => void) | undefined;
  #active: Workspace | undefined;

  constructor(
    api: WorkspaceFileApi,
    readonly cleanBytes: number,
  ) {
    const reads = new DirectoryQueue();
    const list = api.listDirectory;
    const watch = api.watchFiles;
    this.api = {
      ...api,
      read: (target, path, hash, signal) =>
        this.guard(target.threadId, () => workspaceRead(reads, signal, () => api.read(target, path, hash, signal))),
      ...(list && {
        listDirectory: (request, signal) =>
          this.guard(request.threadId ?? "", () => workspaceRead(reads, signal, () => list(request, signal))),
      }),
      ...(watch && {
        watchFiles: (request, signal, receive) =>
          this.guard(request.threadId ?? "", () => watch(request, signal, receive)),
      }),
      write: async (target, path, text, hash, root) => {
        const file = await this.guard(target.threadId, () => api.write(target, path, text, hash, root));

        for (const listener of this.#fileListeners) listener({ threadId: target.threadId, path });

        return file;
      },
      remove: async (target, path, hash, root) => {
        await this.guard(target.threadId, () => api.remove(target, path, hash, root));

        for (const listener of this.#fileListeners) listener({ threadId: target.threadId, path });
      },
    };
  }

  watchFiles(listener: (change: { threadId: string; path: string; revoked?: boolean } | null) => void): () => void {
    this.#fileListeners.add(listener);

    return () => this.#fileListeners.delete(listener);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };
  getVersion = (): number => this.#version;

  private async guard<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof WorkspaceAccessRevoked) {
        const view = this.views.get(threadId);

        for (const tab of view?.files ?? []) tab.document.dispose();

        if (view) {
          view.tabs = [];
          view.active = "thread";
          view.sidebar = undefined;
          view.error = "File access ended. Reopen the thread to check access.";
        }

        for (const listener of this.#fileListeners) listener({ threadId, path: "", revoked: true });
        this.notify(true);
      }

      throw cause;
    }
  }

  view(threadId: string): Workspace {
    let view = this.views.get(threadId);

    if (!view) {
      view = new Workspace(threadId, this);
      this.views.set(threadId, view);
    }

    return view;
  }

  touch(view: Workspace): void {
    if (this.#active !== view) this.#active?.currentFile?.document.cancel();
    this.#active = view;
    this.views.delete(view.threadId);
    this.views.set(view.threadId, view);

    for (const [id, candidate] of this.views) {
      if (this.views.size <= 30) break;

      if (candidate === view || candidate.files.some((tab) => tab.document.editing || tab.document.busy)) continue;

      for (const tab of candidate.files) tab.document.dispose();
      this.views.delete(id);
    }

    this.trim();
  }

  reserveDraft(document: WorkspaceFile, bytes: number): boolean {
    return (
      this.documents()
        .filter((entry) => entry !== document)
        .reduce((sum, entry) => sum + entry.draftBytes, bytes) <= DRAFT_BYTES
    );
  }

  documents(): WorkspaceFile[] {
    return [...this.views.values()].flatMap((view) => view.files.map((tab) => tab.document));
  }

  trim(): void {
    const documents = this.documents();
    let bytes = documents.reduce((sum, entry) => sum + entry.bytes, 0);
    const warm = new Set(documents.filter((entry) => entry.file));
    const warmLimit = this.cleanBytes <= 8 * 1024 * 1024 ? 2 : 4;

    for (const entry of documents) {
      if (bytes <= this.cleanBytes && warm.size <= warmLimit) break;

      if (entry.editing || entry.busy || this.#active?.currentFile?.document === entry) continue;
      bytes -= entry.bytes;
      warm.delete(entry);
      entry.release();
    }
  }

  notify(persist = false): void {
    this.#version++;

    if (persist) this.persist();

    for (const listener of this.#listeners) listener();
  }

  connect(raw: string | null, persist: (raw: string) => void): void {
    this.clear();
    restoreWorkspace(this, raw);
    this.#persist = persist;
    this.notify();
  }

  clear(): void {
    for (const listener of this.#fileListeners) listener(null);
    this.#active = undefined;
    this.#persist = undefined;

    for (const document of this.documents()) document.dispose();
    this.views.clear();
    this.notify();
  }

  private persist(): void {
    this.#persist?.(workspaceMetadata(this));
  }
}
