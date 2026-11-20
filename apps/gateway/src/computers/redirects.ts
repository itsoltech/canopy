import { create, type DescMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { Schema } from "effect";
import { uuid } from "./agents-context.ts";
import { linkedMessage, MovedError } from "./remote.ts";
import { mapMoveIds, movedAgentTarget, rewriteThreadRead, type MoveKind } from "./redirect-ids.ts";
import { followRedirects, recordRedirects, type RedirectRow as Row } from "./redirect-records.ts";
import type { ComputerStore } from "./store.ts";

const SYNC_LIMIT = 2000;
const NODE = /^[0-9a-f]{64}$/;
const key = (kind: string, id: string, from: string) => `${kind}:${id.toLowerCase()}:${nodeRef(from)}`;

const toItem = (row: Row) =>
  create(link.MovedItemSchema, {
    itemId: row.item_id,
    kind: row.kind,
    homeNodeId: row.home_node_id,
    homeName: row.home_name,
    fromNodeId: row.from_node_id,
    movedAtMs: BigInt(new Date(row.moved_at).getTime()),
  });

export { MovedError };

export class Redirects {
  #rows = new Map<string, Row>();
  constructor(
    private readonly store: ComputerStore,
    private readonly self: () => string,
  ) {}

  async load() {
    const rows = await this.store.query<Row>("SELECT * FROM computer_redirects WHERE owner_user_id=$1::uuid", [
      this.store.owner,
    ]);

    this.#rows = new Map(rows.map((r) => [key(r.kind, r.item_id, r.from_node_id), r]));
  }

  get size() {
    return this.#rows.size;
  }

  home(kind: MoveKind, itemId: string, from: string) {
    return this.#rows.get(key(kind, itemId, from));
  }

  destination(kind: MoveKind, value: string) {
    const { id, node } = splitId(value);

    return [...this.#rows.values()].find(
      (row) => row.kind === kind && row.item_id === id.toLowerCase() && nodeRef(row.home_node_id) === node,
    );
  }

  /** Both sides write the decision inside their move transaction. Publish those persisted rows. */
  async committed(kind: MoveKind, ids: string[], from: string) {
    const rows = await this.store.query<Row>(
      `SELECT * FROM computer_redirects WHERE owner_user_id=$1::uuid AND kind=$2 AND item_id=ANY($3::uuid[])
       AND from_node_id=$4 AND basis='local_move'`,
      [this.store.owner, kind, ids, from],
    );

    for (const r of rows) this.#rows.set(key(r.kind, r.item_id, r.from_node_id), r);

    return rows.map(toItem);
  }

  /** A notice vouches for IDs at its authenticated sender only. Local arrivals require a committed move. */
  async learn(sender: string, items: readonly link.MovedItem[]): Promise<link.MovedItem[]> {
    if (sender === this.self() || !NODE.test(sender)) return [];
    const candidates = new Map<string, link.MovedItem>();

    for (const item of items.slice(0, SYNC_LIMIT)) {
      if (
        item.fromNodeId !== sender ||
        item.homeNodeId === sender ||
        item.homeNodeId === this.self() ||
        !uuid(item.itemId) ||
        !["thread", "bot"].includes(item.kind) ||
        !NODE.test(item.homeNodeId) ||
        item.movedAtMs <= 0n ||
        item.movedAtMs > BigInt(Date.now() + 60_000)
      )
        continue;
      const id = key(item.kind, item.itemId, sender);
      const known = this.#rows.get(id);

      if (known && (known.basis === "local_move" || BigInt(new Date(known.moved_at).getTime()) >= item.movedAtMs))
        continue;

      if ((candidates.get(id)?.movedAtMs ?? 0n) < item.movedAtMs) candidates.set(id, item);
    }

    const learned: link.MovedItem[] = [];
    const values = [...candidates.values()];

    for (let i = 0; i < values.length; i += 128) {
      const rows = await recordRedirects(this.store, values.slice(i, i + 128));

      for (const row of rows) {
        this.#rows.set(key(row.kind, row.item_id, row.from_node_id), row);
        learned.push(toItem(row));
      }
    }

    if (learned.length) {
      try {
        await followRedirects(this.store, learned);
      } catch {
        // A colliding call receipt stays with the original peer.
        for (const item of learned) await followRedirects(this.store, [item]).catch(() => {});
      }
    }

    return learned;
  }

  list(): link.MovedItem[] {
    return [...this.#rows.values()]
      .filter((row) => row.from_node_id === this.self() && row.basis === "local_move")
      .sort((a, b) => new Date(b.moved_at).getTime() - new Date(a.moved_at).getTime())
      .slice(0, SYNC_LIMIT)
      .map(toItem);
  }

  /** Follow successive, independently authenticated departures, starting at the referenced home. */
  resolve(kind: MoveKind, value: string): Row | undefined {
    const { id, node } = splitId(value);

    if (!uuid(id)) return undefined;
    let origin = node ?? nodeRef(this.self());
    const seen = new Set<string>();
    let last: Row | undefined;

    for (;;) {
      if (seen.has(origin)) return undefined;
      seen.add(origin);
      const row = this.home(kind, id, origin);

      if (!row) return last;
      last = row;
      origin = nodeRef(row.home_node_id);
    }
  }

  map(kind: MoveKind, value: string) {
    const row = this.resolve(kind, value);

    if (!row) return value;

    return row.home_node_id === this.self() ? row.item_id : qualifyId(row.item_id, row.home_node_id);
  }

  rewrite(desc: DescMessage, message: Message) {
    let changed = rewriteThreadRead(message, (id) => this.map("thread", id));
    mapMoveIds(desc, message, (value, kind) => {
      const next = this.map(kind, value);
      changed ||= value !== next;

      return next;
    });

    return changed;
  }

  /** Answer with our own departure, never with an edge attested by someone else. */
  refuse(method: DescMethod, request: Message) {
    if (!this.#rows.size) return;
    const moved = new Map<string, link.MovedItem>();

    const check = (value: string, kind: MoveKind) => {
      const row = uuid(value) && this.home(kind, value, this.self());

      if (row && row.basis === "local_move") moved.set(key(kind, value, this.self()), toItem(row));

      return value;
    };

    if (method.name === "CallAgentBus") {
      const call = linkedMessage(link.LinkedAgentCallSchema, request);

      try {
        const args = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(call.argumentsJson));
        const target = movedAgentTarget(call.operation, args);

        if (target) check(target.id, target.kind);
      } catch {
        /* the home validates the request */
      }
    } else mapMoveIds(method.input, request, check);

    if (moved.size) throw new MovedError([...moved.values()]);
  }
}
