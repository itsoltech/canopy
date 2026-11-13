import { fileLocation, fileName } from "./file-references.ts";
import { objectsOf, parseObject, str } from "./json.ts";
import { WorkspaceFile, type WorkspaceFileApi, type WorkspaceFileTarget } from "./workspace-file.ts";

export const WORKSPACE_TAB_LIMIT = 12;
const METADATA_BYTES = 256 * 1024;
const DRAFT_BYTES = 4 * 1024 * 1024;

export interface WorkspaceTab {
  readonly id: string;
  readonly document: WorkspaceFile;
  preview: boolean;
}

/** One thread's tab model. Thread is implicit and always first; focus never follows storage events. */
export class Workspace {
  tabs: WorkspaceTab[] = [];
  active = "thread";
  error = "";
  #recent: string[] = [];
  #next = 0;
  #metadata = new Map<string, string>();

  constructor(
    readonly threadId: string,
    readonly store: WorkspaceStore,
  ) {}

  get current(): WorkspaceTab | undefined {
    return this.tabs.find((tab) => tab.id === this.active);
  }
  get dirty(): WorkspaceTab[] {
    return this.tabs.filter((tab) => tab.document.dirty);
  }

  open(target: WorkspaceFileTarget): void {
    const location = fileLocation(target.path);
    const next = { ...target, ...location };

    const existing = this.tabs.find(
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

    const preview = this.tabs.find((tab) => tab.preview && !tab.document.dirty && !tab.document.busy);

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

    this.tabs = [...this.tabs, { id, document, preview: true }];
    this.select(id);
  }

  select(id: string): void {
    if (id !== "thread" && !this.tabs.some((tab) => tab.id === id)) return;

    if (this.active !== id) this.current?.document.cancel();
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

    if (!tab || tab.document.dirty || tab.document.busy) return false;
    tab.document.cancel();
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
    const tab = this.tabs.find((tab) => tab.id === id);

    if (!tab) return;

    if (tab.document.editing) tab.preview = false;

    const duplicate = this.tabs.find(
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
  readonly views = new Map<string, Workspace>();
  #listeners = new Set<() => void>();
  #version = 0;
  #persist: ((raw: string) => void) | undefined;
  #active: Workspace | undefined;

  constructor(
    readonly api: WorkspaceFileApi,
    readonly cleanBytes: number,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };
  getVersion = (): number => this.#version;

  view(threadId: string): Workspace {
    let view = this.views.get(threadId);

    if (!view) {
      view = new Workspace(threadId, this);
      this.views.set(threadId, view);
    }

    return view;
  }

  touch(view: Workspace): void {
    if (this.#active !== view) this.#active?.current?.document.cancel();
    this.#active = view;
    this.views.delete(view.threadId);
    this.views.set(view.threadId, view);

    for (const [id, candidate] of this.views) {
      if (this.views.size <= 30) break;

      if (candidate === view || candidate.tabs.some((tab) => tab.document.editing || tab.document.busy)) continue;

      for (const tab of candidate.tabs) tab.document.cancel();
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
    return [...this.views.values()].flatMap((view) => view.tabs.map((tab) => tab.document));
  }

  trim(): void {
    const documents = this.documents();
    let bytes = documents.reduce((sum, entry) => sum + entry.bytes, 0);

    for (const entry of documents) {
      if (bytes <= this.cleanBytes) break;

      if (entry.editing || entry.busy || this.#active?.current?.document === entry) continue;
      bytes -= entry.bytes;
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

    if (raw && raw.length <= METADATA_BYTES) {
      for (const saved of objectsOf(parseObject(raw)["views"]).slice(-30)) {
        const id = str(saved["threadId"]);

        if (!id || id.length > 1024) continue;
        const view = this.view(id);

        for (const tab of objectsOf(saved["tabs"]).slice(0, WORKSPACE_TAB_LIMIT - 1)) {
          const path = str(tab["path"]);
          const threadId = str(tab["threadId"]);

          if (!path || path.length > 4096 || !threadId || threadId.length > 1024) continue;
          view.open({ threadId, path, itemId: str(tab["itemId"]) });
          view.keep(view.active);
        }

        const index = Number(saved["active"]);
        view.active = view.tabs[index - 1]?.id ?? "thread";
      }
    }

    this.#persist = persist;
    this.notify();
  }

  clear(): void {
    this.#active = undefined;
    this.#persist = undefined;

    for (const document of this.documents()) document.cancel();
    this.views.clear();
    this.notify();
  }

  private persist(): void {
    const views = [...this.views.values()].slice(-30).map((view) => ({
      threadId: view.threadId,
      active: view.tabs.findIndex((tab) => tab.id === view.active) + 1,
      tabs: view.tabs.map((tab) => ({
        threadId: tab.document.target.threadId,
        path: tab.document.path,
        itemId: tab.document.target.itemId ?? "",
        name: fileName(tab.document.path),
      })),
    }));

    while (views.length && new TextEncoder().encode(JSON.stringify({ views })).length > METADATA_BYTES) views.shift();
    this.#persist?.(JSON.stringify({ views }));
  }
}
