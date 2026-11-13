import { Code, ConnectError } from "@connectrpc/connect";
import { MIRROR_CURSOR } from "@canopy/domain/thread-mirror";
import { syncMetrics } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "./core-context.ts";
import { threadWatchRevision } from "../store/thread-watch-revision.ts";
import { queryFamily } from "../diagnostics/query-context.ts";
import { databaseMonitor } from "../diagnostics/database.ts";

type Watch = { thread: string; cursor: string; send: (cursor: string) => void; fail: (error: Error) => void };

type Subscription = Watch & { scanned: string; relevant: string; interval: number; next: number };

type Revision = { id: string; epoch: string; revision: string; relevant: string; count: string; broad: boolean };

const runtimes = new WeakMap<CoreRuntime, Map<string, ThreadWatchRevisions>>();
const nextProbe = (interval: number) => (Math.floor(Date.now() / interval) + 1) * interval;

/** Local and linked watches of the same owner/runtime share the durable revision mechanism. */
export function threadWatchRevisions(runtime: CoreRuntime, owner: string) {
  let owners = runtimes.get(runtime);

  if (!owners) runtimes.set(runtime, (owners = new Map()));
  let revisions = owners.get(owner);

  if (!revisions) owners.set(owner, (revisions = new ThreadWatchRevisions(runtime, owner)));

  return revisions;
}

class ThreadWatchRevisions {
  readonly #watches = new Set<Subscription>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #probing = false;
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  subscribe(watch: Watch, interval: number) {
    const subscription = {
      ...watch,
      scanned: watch.cursor,
      relevant: watch.cursor,
      interval,
      next: nextProbe(interval),
    };

    this.#watches.add(subscription);
    this.#schedule();

    return () => {
      this.#watches.delete(subscription);
      this.#schedule();
    };
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    if (this.#probing || !this.#watches.size) return;
    const next = [...this.#watches].reduce((minimum, watch) => Math.min(minimum, watch.next), Infinity);

    this.#timer = setTimeout(() => void this.#probe(), Math.max(0, next - Date.now()));
    this.#timer.unref();
  }

  async #probe() {
    if (this.#probing) return;
    this.#probing = true;
    const watches = [...this.#watches].filter((watch) => watch.next <= Date.now());
    const cursors = watches.map((watch) => MIRROR_CURSOR.exec(watch.scanned));

    const after = cursors.reduce(
      (minimum, cursor) => (cursor && BigInt(cursor[2]!) < minimum ? BigInt(cursor[2]!) : minimum),
      BigInt(cursors[0]?.[2] ?? 0),
    );

    try {
      if (!watches.length) return;
      const owner = this.owner;
      const ids = [...new Set(watches.map((watch) => watch.thread))];

      const rows = await this.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql
            .unsafe<Revision>(threadWatchRevision, [owner, ids, after.toString()])
            .pipe(queryFamily("watch.revision"));
        }),
      );

      syncMetrics?.record("sync.watch_revision.query", 0);
      databaseMonitor(this.runtime)?.collector?.measure(30, 1);
      const byThread = new Map(rows.map((row) => [row.id, row]));

      for (const watch of watches) {
        if (!this.#watches.has(watch)) continue;
        watch.next = nextProbe(watch.interval);
        const row = byThread.get(watch.thread);
        const base = MIRROR_CURSOR.exec(watch.scanned);

        if (!row || !base) {
          watch.fail(new ConnectError("Thread revision unavailable", Code.DataLoss));
          continue;
        }

        const full = row.broad || row.epoch !== base[1] || BigInt(row.count) !== BigInt(row.revision) - after;
        const revision = full ? row.revision : BigInt(row.relevant) > BigInt(base[2]!) ? row.relevant : undefined;
        watch.scanned = `${row.epoch}:${row.revision}`;

        if (revision !== undefined) watch.relevant = `${row.epoch}:${revision}`;
        watch.send(watch.relevant);
      }
    } catch {
      for (const watch of watches)
        if (this.#watches.has(watch)) {
          watch.next = nextProbe(watch.interval);
          watch.fail(new Error("Thread revision probe failed"));
        }
    } finally {
      this.#probing = false;
      this.#schedule();
    }
  }
}
