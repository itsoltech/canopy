import { create, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { Code, ConnectError } from "@connectrpc/connect";
import { heapStats } from "bun:jsc";
import { computersState } from "../../../apps/gateway/src/computers/runtime-context.ts";
import { computersSyncMirror } from "../../../apps/gateway/src/computers/runtime-mirrors.ts";
import { readThreadRange } from "../../../apps/gateway/src/computers/range-source.ts";
import { eventually } from "./gateway.ts";
import type { Control } from "./sync-process.ts";
import type { scenarioComputer } from "./sync-scenario.ts";

type Computer = Awaited<ReturnType<typeof scenarioComputer>>;

type Reader = { abort: AbortController; done: Promise<void>; failed: () => boolean; visible: () => boolean };

/** Retention fixture: real mirrors and client reducers, no traces or saved batch payloads. */
export class SyncMemoryScenario {
  readonly #readers: Reader[] = [];
  #rotation = 0;
  #brokenSeq = 0n;
  #project = "";
  #workspace = "";
  constructor(readonly computer: Computer) {}

  async execute(command: Control): Promise<string> {
    switch (command.action) {
      case "memory-seed":
        await this.seed(command.count);
        break;
      case "memory-watch":
        await this.watch(command);
        break;
      case "memory-release":
        await this.release();
        break;
      case "memory-gc":
        return this.sample();
      case "memory-reconnect":
        await this.reconnect(command.node, command.threads[0]!);
        break;
      case "memory-caught":
        await this.caught(command);
        break;
      case "memory-corrupt":
        await this.corrupt();
        break;
      case "memory-failed":
        await this.failed(command);
        break;
      case "memory-repair":
        await this.repair(command.code);
        break;
      case "memory-grow":
        await this.items(this.computer.threads[0]!, 513, 2048);
        break;
      case "memory-title":
        await this.computer.gateway.api.updateThread({ threadId: this.computer.threads[0]!, title: command.code });
        break;
      case "memory-suppressed": {
        const rows = await this.computer.links.store.query<{ attempts: number }>(
          "SELECT attempts FROM thread_publication_failures WHERE thread_id=$1::uuid",
          [this.computer.threads[0]],
        );

        if (rows[0]?.attempts !== 1) throw new Error("Deterministic failure was retried after reconnect");
        break;
      }

      default:
        throw new Error("Unknown memory command");
    }

    return "";
  }

  async seed(count: number) {
    await this.release();
    const { gateway, links, threads } = this.computer;

    if (![1, 10, 50].includes(count)) throw new Error("Unexpected memory fixture size");

    if (!this.#project) {
      this.#project = (await gateway.api.createProject({ name: "Bounded sync retention" })).project!.id;
      this.#workspace = (
        await gateway.api.createWorkspace({
          projectId: this.#project,
          workerId: gateway.workerId,
          rootPath: "/repo/retention",
        })
      ).workspace!.id;
    }

    await links.store.query("UPDATE threads SET deleted_at=now() WHERE owner_user_id=$1::uuid AND deleted_at IS NULL", [
      gateway.userId,
    ]);
    threads.length = 0;

    for (let n = 0; n < count; n++) {
      const id = (
        await gateway.api.createThread({
          projectId: this.#project,
          workspaceId: this.#workspace,
          provider: Provider.CODEX,
          title: `Retention ${n}`,
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!.id;

      threads.push(id);
      await this.items(id, 1, n === 0 ? 512 : 8);
    }
  }

  async items(thread: string, first: number, last: number) {
    await this.computer.links.store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-'||n,'commandExecution','completed',jsonb_build_object('itemId','item-'||n,
        'status','COMPLETED','commandExecution',jsonb_build_object('command','synthetic','output',repeat(md5(n::text),1024))),n,n
      FROM generate_series($2::int,$3::int) n`,
      [thread, first, last],
    );
    await this.computer.links.store.query("UPDATE threads SET last_seq=$2 WHERE id=$1::uuid", [thread, last]);
  }

  async watch(command: Control) {
    await this.release();

    if (!command.threads.length) throw new Error("Missing memory threads");
    const watchers = command.count || 8;

    if (watchers < 1 || watchers > 50) throw new Error("Unexpected watcher count");
    const ready: Promise<void>[] = [];

    for (let n = 0; n < watchers; n++) {
      const thread = command.threads[command.count ? n : n === 0 ? 0 : (this.#rotation + n) % command.threads.length]!;
      const abort = new AbortController();
      const first = Promise.withResolvers<void>();
      let state: ui.ThreadSnapshot | undefined;
      let failed = false;

      const done = (async () => {
        try {
          for await (const update of this.computer.gateway.api.watchThread(
            { threadId: qualifyId(thread, command.node), sequence: true },
            { signal: abort.signal, timeoutMs: 20_000 },
          )) {
            state = applyThreadUpdate(state, update);

            if (state.thread && state.items.length) first.resolve();
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            failed = ConnectError.from(error).code === Code.DataLoss;

            if (!failed) first.reject(error);
          }
        } finally {
          if (!state) first.reject(new Error("Watch ended before its recent window"));
        }
      })();

      this.#readers.push({ abort, done, failed: () => failed, visible: () => !!state?.items.length });
      ready.push(first.promise);
    }

    this.#rotation++;
    await Promise.all(ready);
  }

  async release() {
    const readers = this.#readers.splice(0);

    for (const reader of readers) reader.abort.abort();
    await Promise.all(readers.map((reader) => reader.done));
  }

  async sample() {
    await Bun.sleep(100);
    Bun.gc(true);
    await Bun.sleep(50);
    Bun.gc(true);
    const memory = process.memoryUsage();
    const windows = heapStats().objectTypeCounts["SequenceWindow"] ?? 0;

    return JSON.stringify({
      heap: memory.heapUsed,
      rss: memory.rss,
      external: memory.external,
      windows,
      waiting: this.computer.links.rangePublisher.waiting.size,
    });
  }

  async reconnect(node: string, thread: string) {
    const links = this.computer.links;

    const failedAt = async () =>
      (
        await links.store.query<{ at: string | null }>(
          "SELECT failed_at::text AS at FROM thread_range_failures WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
          [links.store.owner, node, thread],
        )
      )[0]?.at;

    const previousFailure = await failedAt();
    const previousSubscription = (await links.mirror.state(node))?.subscription_id;
    const previousController = links[computersState].mirroring.get(node);
    previousController?.abort();

    if (!(await eventually(async () => links[computersState].mirroring.get(node) !== previousController, Boolean)))
      throw new Error("Mirror did not close");
    computersSyncMirror(links, node);

    if (
      !(await eventually(
        async () => (await links.mirror.state(node))?.subscription_id !== previousSubscription,
        Boolean,
      ))
    )
      throw new Error("Mirror did not begin a new durable subscription");

    if (previousFailure && !(await eventually(async () => (await failedAt()) !== previousFailure, Boolean)))
      throw new Error("Mirror did not report the durable failure to its new subscription");
  }

  async caught(command: Control) {
    const store = this.computer.links.store;

    const ready = await eventually(
      async () => {
        const rows = await store.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM thread_range_state
        WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=ANY($3::uuid[]) AND applied_seq=head_seq`,
          [store.owner, command.node, command.threads],
        );

        const thread = command.code
          ? await this.computer.links.mirror.thread(command.node, command.threads[0]!)
          : undefined;

        return rows[0]?.count === command.threads.length && (!command.code || thread?.title === command.code);
      },
      Boolean,
      15_000,
    );

    if (!ready) throw new Error("Memory mirror did not catch up");
  }

  async corrupt() {
    const store = this.computer.links.store;
    const thread = this.computer.threads[0]!;
    await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));

    const rows = await store.query<{ seq: string }>(
      `WITH next AS (UPDATE thread_replication_clock SET head_seq=head_seq+1 WHERE thread_id=$1::uuid RETURNING epoch,head_seq)
      INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id,payload)
      SELECT $1::uuid,epoch,head_seq,'future','broken',decode('0f','hex') FROM next RETURNING seq::text`,
      [thread],
    );

    this.#brokenSeq = BigInt(rows[0]!.seq);
  }

  async failed(command: Control) {
    const store = this.computer.links.store;

    const failed = await eventually(
      async () => {
        const rows = await store.query<{ reason: string }>(
          `SELECT reason FROM thread_range_failures WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid`,
          [store.owner, command.node, command.threads[0]],
        );

        return (
          rows[0]?.reason === "decode_error" && this.#readers.some((reader) => reader.failed() && reader.visible())
        );
      },
      Boolean,
      15_000,
    );

    if (!failed) throw new Error("Expected a scoped decode failure with cached content");
    let rejected = false;

    try {
      await store.query(
        `UPDATE thread_range_state SET applied_seq=head_seq+1
        WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid`,
        [store.owner, command.node, command.threads[0]],
      );
    } catch {
      rejected = true;
    }

    if (!rejected) throw new Error("Expected the invalid durable write to fail");
    await this.computer.gateway.api.getThread({ threadId: qualifyId(command.threads[0]!, command.node) });
  }

  async repair(title: string) {
    const thread = this.computer.threads[0]!;

    const payload = toBinary(
      ui.ThreadSyncRecordSchema,
      create(ui.ThreadSyncRecordSchema, {
        seq: this.#brokenSeq,
        key: "future:broken",
      }),
    );

    await this.computer.links.store.query(
      "UPDATE thread_replication_journal SET payload=$3 WHERE thread_id=$1::uuid AND seq=$2",
      [thread, this.#brokenSeq, payload],
    );
    await this.computer.gateway.api.updateThread({ threadId: thread, title });
  }
}
