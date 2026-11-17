import { HttpError } from "#lib/shared/http.ts";
import { readThreadDiff, ThreadDiffError, type ThreadDiffFile, type ThreadDiffLine } from "./diff-api.ts";

export const DIFF_PAGE_LINES = 128;
const MAX_PAGES = 128;
const MAX_BYTES = 16 * 1024 * 1024;

export interface DiffPageTarget {
  path: string;
  offset: number;
  count: number;
}

const pageKey = (target: DiffPageTarget) => `${target.path}\0${target.offset}`;

/** Viewport pages precede nearby prefetch; leaving that window cancels obsolete work. */
export class DiffPages {
  revision = $state(0);
  error = $state("");
  #cache = new Map<string, { lines: ThreadDiffLine[]; bytes: number }>();
  #running = new Map<string, AbortController>();
  #wanted = new Map<string, DiffPageTarget>();
  #failed = new Set<string>();
  #snapshot = "";
  #generation = 0;
  #bytes = 0;

  constructor(
    readonly threadId: string,
    readonly accessEnded: () => void,
  ) {}

  line(path: string, offset: number): ThreadDiffLine | undefined {
    void this.revision;
    const start = Math.floor(offset / DIFF_PAGE_LINES) * DIFF_PAGE_LINES;

    return this.#cache.get(`${path}\0${start}`)?.lines[offset - start];
  }

  window(snapshot: string, targets: DiffPageTarget[]): void {
    if (snapshot !== this.#snapshot) {
      this.clear();
      this.#snapshot = snapshot;
    }

    this.#wanted = new Map(targets.map((target) => [pageKey(target), target]));
    this.#failed = new Set([...this.#failed].filter((key) => this.#wanted.has(key)));

    for (const [key, controller] of this.#running) {
      if (!this.#wanted.has(key)) controller.abort();
    }

    for (const key of this.#wanted.keys()) {
      const page = this.#cache.get(key);

      if (page) {
        this.#cache.delete(key);
        this.#cache.set(key, page);
      }
    }

    this.pump();
  }

  private pump(): void {
    for (const [key, target] of this.#wanted) {
      if (this.#running.size >= 3) break;

      if (this.#cache.has(key) || this.#running.has(key) || this.#failed.has(key)) continue;
      const controller = new AbortController();
      this.#running.set(key, controller);
      void this.read(key, target, controller);
    }
  }

  private async read(key: string, target: DiffPageTarget, controller: AbortController): Promise<void> {
    const generation = this.#generation;
    const snapshot = this.#snapshot;
    const lines: ThreadDiffLine[] = [];

    try {
      while (lines.length < target.count) {
        const page = await readThreadDiff(
          this.threadId,
          snapshot,
          target.path,
          target.offset + lines.length,
          target.count - lines.length,
          controller.signal,
        );

        if (controller.signal.aborted || generation !== this.#generation) return;

        if (page.error !== ThreadDiffError.UNSPECIFIED) {
          this.error = "These changes are no longer available. Refresh changes to continue.";
          this.#failed.add(key);

          return;
        }

        if (!page.lines.length) throw new Error("No diff lines returned.");
        lines.push(...page.lines);
      }

      const bytes = lines.reduce((sum, line) => sum + line.text.length * 2 + 80, 0);
      this.#cache.set(key, { lines, bytes });
      this.#bytes += bytes;
      this.trim();
      this.revision++;
    } catch (cause) {
      if (cause instanceof HttpError && [401, 403, 404].includes(cause.status) && generation === this.#generation) {
        this.clear();
        this.accessEnded();

        return;
      }

      if (!controller.signal.aborted && generation === this.#generation) {
        this.#failed.add(key);
        this.error = "Changes could not be loaded. Check the connection, then retry.";
      }
    } finally {
      if (this.#running.get(key) === controller) this.#running.delete(key);

      if (generation === this.#generation) this.pump();
    }
  }

  private trim(): void {
    for (const [key, page] of this.#cache) {
      if (this.#cache.size <= MAX_PAGES && this.#bytes <= MAX_BYTES) break;
      this.#cache.delete(key);
      this.#bytes -= page.bytes;

      if (this.#wanted.has(key)) {
        this.#failed.add(key);
        this.error = "Some lines exceed the review limit. Reduce the visible changes, then retry.";
      }
    }
  }

  retry(): void {
    this.#failed.clear();
    this.error = "";
    this.pump();
  }

  pause(): void {
    this.#wanted.clear();
    this.clear();
  }

  clear(): void {
    this.#generation++;

    for (const controller of this.#running.values()) controller.abort();
    this.#running.clear();
    this.#cache.clear();
    this.#failed.clear();
    this.#bytes = 0;
    this.error = "";
    this.revision++;
  }
}

export function diffPageTargets(rows: readonly { file: ThreadDiffFile; offset: number }[]): DiffPageTarget[] {
  const targets = new Map<string, DiffPageTarget>();

  for (const row of rows) {
    if (row.offset < 0 || !row.file.lineCount) continue;
    const offset = Math.floor(row.offset / DIFF_PAGE_LINES) * DIFF_PAGE_LINES;
    const target = { path: row.file.path, offset, count: Math.min(DIFF_PAGE_LINES, row.file.lineCount - offset) };
    targets.set(pageKey(target), target);
  }

  return [...targets.values()].slice(0, MAX_PAGES);
}
