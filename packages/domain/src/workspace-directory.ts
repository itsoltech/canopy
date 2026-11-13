import { toBinary } from "@bufbuild/protobuf";
import {
  ThreadDirectoryPageSchema,
  ThreadDirectoryError,
  ThreadDirectoryKind,
  type ThreadDirectoryEntry,
} from "@canopy/contracts";
import type { WorkspaceStore } from "./workspace.ts";
import { DirectoryQueue } from "./workspace-directory-queue.ts";
import { observeWorkspaceDirectory } from "./workspace-directory-watch.ts";

interface Directory {
  path: string;
  entries: ThreadDirectoryEntry[];
  revision: string;
  token: string;
  complete: boolean;
  bytes: number;
  error: string;
  status: string;
  read: AbortController | undefined;
}

export type DirectoryRow =
  | { key: string; kind: "entry"; entry: ThreadDirectoryEntry; depth: number }
  | { key: string; kind: "more" | "state"; directory: string; depth: number };

const caches = new WeakMap<WorkspaceStore, DirectoryCache>();

export function workspaceDirectories(store: WorkspaceStore, budget: number): DirectoryCache {
  let cache = caches.get(store);

  if (!cache) {
    cache = new DirectoryCache(store, budget);
    caches.set(store, cache);
  }

  return cache;
}

class DirectoryCache {
  readonly trees = new Map<string, WorkspaceDirectory>();
  readonly queue = new DirectoryQueue();

  constructor(
    readonly store: WorkspaceStore,
    readonly budget: number,
  ) {
    store.watchFiles((change) => {
      if (!change) {
        for (const tree of this.trees.values()) tree.dispose();
        this.trees.clear();
      } else if (change.revoked) {
        this.trees.get(change.threadId)?.dispose();
        this.trees.delete(change.threadId);
      } else this.trees.get(change.threadId)?.invalidate();
    });
  }

  tree(threadId: string): WorkspaceDirectory {
    let tree = this.trees.get(threadId);

    if (!tree) {
      tree = new WorkspaceDirectory(threadId, this);
    }

    this.trees.delete(threadId);
    this.trees.set(threadId, tree);

    for (const [id, entry] of this.trees) {
      if (this.trees.size <= 30) break;

      if (entry.users || entry === tree) continue;
      entry.clear();
      this.trees.delete(id);
    }

    return tree;
  }

  reserve(node: Directory, bytes: number): boolean {
    const total = () => [...this.trees.values()].reduce((sum, entry) => sum + entry.bytes, 0) - node.bytes + bytes;

    for (const entry of this.trees.values()) {
      if (total() <= this.budget) break;

      for (const [path, candidate] of entry.nodes) {
        if (candidate === node || candidate.read || (entry.users && (!path || entry.expanded.has(path)))) continue;
        entry.drop(path);
      }
    }

    return total() <= this.budget;
  }

  async trimCursors(keep: Directory): Promise<void> {
    const cursors = [...this.trees.values()].flatMap((tree) =>
      [...tree.nodes.values()].flatMap((node) => (node.token && node !== keep && !node.read ? [{ tree, node }] : [])),
    );

    // Four idle cursors plus two active reads stay below the worker's eight handles.
    for (const { tree, node } of cursors.slice(0, Math.max(0, cursors.length - 3))) {
      const token = node.token;
      node.token = "";
      await tree.release(node.path, token);
    }
  }
}

/** Shared by the visible sidebar and full tab. Contents never enter view-state storage. */
export class WorkspaceDirectory {
  readonly nodes = new Map<string, Directory>();
  readonly expanded = new Set<string>();
  users = 0;
  includeIgnored = false;
  rootIdentity = "";
  watchStatus = "";
  #stopWatch: (() => void) | undefined;
  #listeners = new Set<() => void>();
  #version = 0;
  #stale = false;
  #disposed = false;

  constructor(
    readonly threadId: string,
    readonly cache: DirectoryCache,
  ) {}

  get bytes() {
    return [...this.nodes.values()].reduce((sum, node) => sum + node.bytes, 0);
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };
  getVersion = () => this.#version;
  notify() {
    this.#version++;

    for (const listener of this.#listeners) listener();
  }

  retain(): () => void {
    if (this.#disposed) return () => {};

    this.users++;

    if (this.users === 1 && (!this.nodes.get("")?.revision || this.#stale)) this.invalidate();

    if (this.users === 1) this.#stopWatch = observeWorkspaceDirectory(this);

    let released = false;

    return () => {
      if (released || this.#disposed) return;
      released = true;

      if (--this.users) return;
      this.#stopWatch?.();
      this.#stopWatch = undefined;
      this.#stale = true;

      for (const node of this.nodes.values()) this.cancel(node);
    };
  }

  node(path: string): Directory {
    let node = this.nodes.get(path);

    if (!node) {
      if (this.nodes.size >= 128) {
        for (const candidate of this.nodes.keys()) {
          if (candidate && !this.expanded.has(candidate)) this.drop(candidate);

          if (this.nodes.size < 128) break;
        }
      }

      node = {
        path,
        entries: [],
        revision: "",
        token: "",
        complete: false,
        bytes: 0,
        error: "",
        status: "",
        read: undefined,
      };
      this.nodes.set(path, node);
    }

    return node;
  }

  rows(): DirectoryRow[] {
    const rows: DirectoryRow[] = [];

    const visit = (path: string, depth: number) => {
      const node = this.nodes.get(path);

      if (!node) return;

      for (const entry of node.entries) {
        rows.push({ key: `entry:${entry.path}`, kind: "entry", entry, depth });

        if (entry.kind === ThreadDirectoryKind.DIRECTORY && this.expanded.has(entry.path)) visit(entry.path, depth + 1);
      }

      if (node.read || node.error || (!node.entries.length && node.complete))
        rows.push({ key: `directory:${path}`, kind: "state", directory: path, depth });
      else if (!node.complete) rows.push({ key: `directory:${path}`, kind: "more", directory: path, depth });
    };

    visit("", 0);

    return rows;
  }

  toggle(path: string): void {
    if (this.expanded.delete(path)) {
      for (const node of this.nodes.values())
        if (node.path === path || node.path.startsWith(`${path}/`)) this.cancel(node);
    } else {
      if (this.expanded.size >= 30) {
        this.node("").error = "You have 30 expanded directories. Collapse a directory, then open another.";
        this.notify();

        return;
      }

      this.expanded.add(path);
      const node = this.node(path);

      if (!node.entries.length || (!node.complete && !node.token)) void this.load(path, true);
    }

    this.notify();
  }

  async load(path: string, reload = false): Promise<void> {
    if (this.#disposed) return;
    const node = this.node(path);

    if (node.read) return;
    const list = this.cache.store.api.listDirectory;

    if (!list) {
      node.error = "Update Canopy on your gateway to browse files.";
      this.notify();

      return;
    }

    const controller = new AbortController();
    let done: (() => void) | undefined;
    const includeIgnored = this.includeIgnored;
    const restart = reload || (!node.complete && !node.token);
    node.read = controller;
    node.error = "";
    this.notify();

    try {
      done = await this.cache.queue.acquire(controller.signal);

      if (controller.signal.aborted) return;
      await this.cache.trimCursors(node);

      if (controller.signal.aborted) return;

      if (restart && node.token) {
        const token = node.token;
        node.token = "";
        await this.release(path, token, includeIgnored);
      }

      const page = await list(
        {
          threadId: this.threadId,
          directory: path,
          pageSize: 100,
          pageToken: restart ? "" : node.token,
          knownRevision: restart ? "" : node.revision,
          includeIgnored,
        },
        controller.signal,
      );

      if (controller.signal.aborted || this.nodes.get(path) !== node) {
        this.release(path, page.nextPageToken, includeIgnored);

        return;
      }

      if (page.error !== ThreadDirectoryError.UNSPECIFIED)
        throw new Error("This directory changed or its page expired. Reload the directory to continue.");

      if (this.rootIdentity && this.rootIdentity !== page.rootIdentity) {
        void this.release(path, page.nextPageToken, includeIgnored);
        this.clear();
        this.node("").error = "The working directory changed. Reload Files to continue.";

        return;
      }

      this.rootIdentity = page.rootIdentity;
      const bytes = (restart ? 0 : node.bytes) + toBinary(ThreadDirectoryPageSchema, page).byteLength;

      if (!this.cache.reserve(node, bytes)) {
        this.release(path, page.nextPageToken);
        node.token = "";
        throw new Error(
          "The file tree reached its memory limit. Collapse unused directories or reload this directory from the start.",
        );
      }

      const entries = restart ? page.entries : [...node.entries, ...page.entries];
      node.entries = [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort(
        (a, b) =>
          Number(b.kind === ThreadDirectoryKind.DIRECTORY) - Number(a.kind === ThreadDirectoryKind.DIRECTORY) ||
          a.name.localeCompare(b.name),
      );
      node.bytes = bytes;
      node.token = page.nextPageToken;
      node.revision = page.directoryRevision;
      node.complete = page.complete;
      node.status = page.gitStatusComplete ? "" : page.gitStatusReason || "Status unavailable";
    } catch (cause) {
      if (!controller.signal.aborted)
        node.error = cause instanceof Error ? cause.message : "Could not load this directory. Reload it to try again.";
    } finally {
      done?.();

      if (node.read === controller) node.read = undefined;
      this.notify();
    }
  }

  invalidate(paths: Iterable<string> = ["", ...this.expanded]): void {
    if (this.#disposed) return;

    if (!this.users) {
      this.#stale = true;

      return;
    }

    this.#stale = false;

    for (const path of paths) {
      if (path && !this.expanded.has(path)) continue;
      const node = this.nodes.get(path);

      if (node) {
        this.cancel(node);
        node.revision = "";
      }

      if (this.users) void this.load(path, true);
    }
  }

  showIgnored(value: boolean): void {
    this.clear();
    this.includeIgnored = value;
    this.invalidate();
  }

  drop(path: string): void {
    const node = this.nodes.get(path);

    if (node) this.cancel(node);
    this.nodes.delete(path);
  }

  clear(): void {
    for (const node of this.nodes.values()) this.cancel(node);
    this.nodes.clear();
    this.expanded.clear();
    this.rootIdentity = "";
    this.notify();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.users = 0;
    this.clear();
  }

  private cancel(node: Directory): void {
    node.read?.abort();
    node.read = undefined;
    this.release(node.path, node.token);
    node.token = "";
  }

  async release(directory: string, pageToken: string, includeIgnored = this.includeIgnored): Promise<void> {
    if (!pageToken) return;
    await this.cache.store.api
      .listDirectory?.(
        { threadId: this.threadId, directory, pageToken, includeIgnored, release: true },
        new AbortController().signal,
      )
      .catch(() => {});
  }
}
