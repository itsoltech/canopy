import { create, toBinary } from "@bufbuild/protobuf";
import {
  ThreadDirectoryEntrySchema,
  ThreadDirectoryPageSchema,
  ThreadDirectoryKind as Kind,
  ThreadDirectoryError as Failure,
  type ListThreadDirectory,
  type ThreadDirectoryEntry,
} from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { directoryDeleted, directoryGit, directoryStatus, type DirectoryGit } from "./directory-git.ts";
import { directoryIdentity, directoryPath, directoryRevision } from "./thread-directory-path.ts";
import { VerifiedDirectory, type DirectoryHandle } from "./directory-handle.ts";

type Target = Awaited<ReturnType<typeof directoryPath>>;

interface Session {
  key: string;
  target: Target;
  iterator: DirectoryHandle;
  token: string;
  timer: ReturnType<typeof setTimeout>;
  pending?: ThreadDirectoryEntry | undefined;
  deleted: string[];
  ended: boolean;
  closed: boolean;
}

/** Eight bounded native directory iterators; no recursive manifest, journal or replay. */
export class ThreadDirectories {
  #sessions = new Map<string, Session>();
  #live = new Set<Session>();
  #opening = 0;
  #epoch = 0;

  async list(request: ListThreadDirectory) {
    const started = performance.now();
    const epoch = this.#epoch;
    const target = await directoryPath(request.workspace, request.directory);

    const key = directoryIdentity(
      JSON.stringify([
        request.ownerId,
        request.threadId,
        target.rootIdentity,
        target.directory,
        request.includeIgnored,
      ]),
    );

    const session = request.pageToken ? this.#sessions.get(request.pageToken) : undefined;

    if (request.pageToken && (!session || session.key !== key || session.closed))
      return create(ThreadDirectoryPageSchema, { error: Failure.CURSOR_EXPIRED });

    if (request.release) {
      if (session) await this.#close(session);

      return create(ThreadDirectoryPageSchema, { complete: true });
    }

    if (
      (session && session.target.revision !== target.revision) ||
      (request.knownRevision && request.knownRevision !== target.revision)
    ) {
      if (session) await this.#close(session);

      return create(ThreadDirectoryPageSchema, { error: Failure.DIRECTORY_CHANGED });
    }

    if (session) {
      this.#sessions.delete(session.token); // A cursor is consumed once, including concurrent calls.
      clearTimeout(session.timer);
    }

    const cursor = session ?? (await this.#open(key, target));

    try {
      const git = await directoryGit(target.root);

      const page = create(ThreadDirectoryPageSchema, {
        rootIdentity: target.rootIdentity,
        directory: target.directory,
        directoryRevision: target.revision,
        gitStatusComplete: git.complete,
        gitStatusReason: git.reason,
      });

      await this.#fill(cursor, request, git, page.entries, started);
      page.gitStatusComplete = git.complete;
      page.gitStatusReason = git.reason;

      if (
        epoch !== this.#epoch ||
        cursor.closed ||
        (await cursor.iterator.revision()) !== target.revision ||
        (await directoryRevision(target.path)) !== target.revision
      ) {
        await this.#close(cursor);

        return create(ThreadDirectoryPageSchema, { error: Failure.DIRECTORY_CHANGED });
      }

      // Re-resolve the boundary after enumeration, before any names leave the worker.
      const current = await directoryPath(request.workspace, request.directory);

      if (current.rootIdentity !== target.rootIdentity || current.path !== target.path) {
        await this.#close(cursor);

        return create(ThreadDirectoryPageSchema, { error: Failure.ROOT_CHANGED });
      }

      page.complete = cursor.ended && !cursor.deleted.length && !cursor.pending;

      if (page.complete) await this.#close(cursor);
      else {
        clearTimeout(cursor.timer);
        cursor.token = crypto.randomUUID();
        cursor.timer = setTimeout(() => void this.#close(cursor), 30_000);
        cursor.timer.unref();
        this.#sessions.set(cursor.token, cursor);
        page.nextPageToken = cursor.token;
      }

      return page;
    } catch (cause) {
      await this.#close(cursor);
      throw cause;
    }
  }

  async #open(key: string, target: Target): Promise<Session> {
    if (this.#live.size + this.#opening >= 8)
      throw new CommandError(
        "DIRECTORY_BUSY",
        "Too many directories are loading. Collapse a directory, then retry.",
        false,
      );
    this.#opening++;

    try {
      const iterator = await VerifiedDirectory.open(target);

      const session: Session = {
        key,
        target,
        iterator,
        token: crypto.randomUUID(),
        ended: false,
        closed: false,
        deleted: [],
        timer: setTimeout(() => {}, 0),
      };

      clearTimeout(session.timer);
      this.#sessions.set(session.token, session);
      this.#live.add(session);

      return session;
    } finally {
      this.#opening--;
    }
  }

  async #fill(
    session: Session,
    request: ListThreadDirectory,
    git: DirectoryGit,
    entries: ThreadDirectoryEntry[],
    started: number,
  ) {
    const limit = Math.max(1, Math.min(request.pageSize || 100, 200));
    let bytes = 1024; // Includes response/CommandResult envelopes and the next cursor.

    while (entries.length < limit && performance.now() - started < 2000 && !session.closed) {
      const entry = session.pending ?? (await this.#next(session, request.includeIgnored, git, started + 2000));
      session.pending = undefined;

      if (!entry) break;
      const size = toBinary(ThreadDirectoryEntrySchema, entry).byteLength + 8;

      if (bytes + size > 63 * 1024) {
        session.pending = entry;
        break;
      }

      bytes += size;
      entries.push(entry);
    }
  }

  async #next(
    session: Session,
    ignored: boolean,
    git: DirectoryGit,
    deadline: number,
  ): Promise<ThreadDirectoryEntry | undefined> {
    while (!session.ended && !session.closed && performance.now() < deadline) {
      const entry = await session.iterator.read();

      if (!entry) {
        session.ended = true;
        session.deleted = directoryDeleted(git, session.target.directory, ignored);
        break;
      }

      if (entry.name === ".git" || (!ignored && entry.name.startsWith("."))) continue;
      const path = session.target.directory ? `${session.target.directory}/${entry.name}` : entry.name;
      const status = directoryStatus(git, path, entry.kind === "directory");

      if (!ignored && status === "!") continue;

      const kind = { symlink: Kind.SYMLINK, directory: Kind.DIRECTORY, file: Kind.FILE, other: Kind.UNSPECIFIED }[
        entry.kind
      ];

      if (kind === Kind.UNSPECIFIED) continue;

      return create(ThreadDirectoryEntrySchema, {
        name: entry.name,
        path,
        kind,
        gitStatus: status,
        ...(entry.kind === "file" && { size: entry.size, modifiedMs: entry.modifiedMs }),
      });
    }

    const deleted = session.deleted.shift();

    return deleted
      ? create(ThreadDirectoryEntrySchema, {
          path: deleted,
          name: deleted.split("/").at(-1) ?? deleted,
          kind: Kind.DELETED,
          gitStatus: "D",
        })
      : undefined;
  }

  async #close(session: Session) {
    session.closed = true;
    clearTimeout(session.timer);
    this.#sessions.delete(session.token);
    this.#live.delete(session);
    await session.iterator.close().catch(() => undefined);
  }

  async close() {
    this.#epoch++;
    await Promise.all([...this.#live].map((session) => this.#close(session)));
  }
}
