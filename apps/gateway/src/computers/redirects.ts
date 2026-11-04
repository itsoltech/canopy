import { create, type DescMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { mapIds, MovedError } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

/**
 * Stage 8 of docs/linked-computers.md: where moved threads and bots live now. A moved thing keeps
 * its uuid, so an old id (`<uuid>` on its former home, `<uuid>~<old home>` elsewhere) resolves by
 * swapping the home. The table is filled by the two sides of a move, by `moved` frames from direct
 * partners and by "moved" answers of a former home (which also cross a relay).
 */
const PLAIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Redirects sent to a partner after each handshake: the most recent ones. */
const SYNC_LIMIT = 2000;

type Row = {
  item_id: string;
  kind: string;
  home_node_id: string;
  home_name: string;
  from_node_id: string;
  moved_at: Date;
};

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

    this.#rows = new Map(rows.map((r) => [r.item_id, r]));
  }
  /** The computer a thread or bot moved to, if it did. */
  home(itemId: string): Row | undefined {
    return this.#rows.get(itemId);
  }
  get size() {
    return this.#rows.size;
  }

  /** Records where a thing lives now; an older notice never replaces a newer one. Returns whether it changed. */
  async record(item: link.MovedItem): Promise<boolean> {
    if (!PLAIN.test(item.itemId) || !["thread", "bot"].includes(item.kind) || !/^[a-f0-9]{64}$/.test(item.homeNodeId))
      return false;
    const known = this.#rows.get(item.itemId);
    const at = new Date(Number(item.movedAtMs) || Date.now());

    if (known && new Date(known.moved_at).getTime() >= at.getTime() && known.home_node_id === item.homeNodeId)
      return false;

    if (known && new Date(known.moved_at).getTime() > at.getTime()) return false;

    const rows = await this.store.query<Row>(
      `INSERT INTO computer_redirects(owner_user_id,item_id,kind,home_node_id,home_name,from_node_id,moved_at)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT (owner_user_id,item_id) DO UPDATE SET kind=EXCLUDED.kind,home_node_id=EXCLUDED.home_node_id,
      home_name=EXCLUDED.home_name,from_node_id=EXCLUDED.from_node_id,moved_at=EXCLUDED.moved_at WHERE computer_redirects.moved_at<=EXCLUDED.moved_at RETURNING *`,
      [this.store.owner, item.itemId, item.kind, item.homeNodeId, item.homeName.slice(0, 120), item.fromNodeId, at],
    );

    if (rows[0]) this.#rows.set(item.itemId, rows[0]);

    return Boolean(rows[0]);
  }

  /** What a partner said moved. Only the former or the new home may say so, and nothing that lives here is moved by a notice. */
  async learn(sender: string, items: readonly link.MovedItem[]): Promise<link.MovedItem[]> {
    const learned: link.MovedItem[] = [];

    for (const item of items.slice(0, SYNC_LIMIT)) {
      if (sender !== item.fromNodeId && sender !== item.homeNodeId) continue;

      if (item.homeNodeId !== this.self() && (await this.#lives(item))) continue;

      if (item.homeNodeId === this.self() && this.#rows.get(item.itemId)?.home_node_id !== this.self()) continue;

      if (await this.record(item)) learned.push(item);
    }

    if (learned.length) await this.#follow(learned);

    return learned;
  }

  /** A thread or bot of this computer that has not moved away. */
  async #lives(item: link.MovedItem) {
    const table = item.kind === "bot" ? "bots" : "threads";

    return (
      (
        await this.store.query(
          `SELECT 1 FROM ${table} WHERE id=$1::uuid AND owner_user_id=$2::uuid AND moved_to IS NULL AND deleted_at IS NULL`,
          [item.itemId, this.store.owner],
        )
      ).length > 0
    );
  }

  /** Agent bus references to a moved thing route to its new home (docs/linked-computers.md, stage 8). */
  async #follow(items: link.MovedItem[]) {
    for (const item of items) {
      await this.store
        .query(
          `UPDATE computer_agent_calls SET peer_node_id=$3 WHERE owner_user_id=$1::uuid AND target_id=$2::uuid AND direction='outgoing' AND peer_node_id=$4`,
          [this.store.owner, item.itemId, item.homeNodeId, item.fromNodeId],
        )
        .catch(() => {});
    }
  }

  /** Redirects for a partner's handshake, newest first. */
  list(): link.MovedItem[] {
    return [...this.#rows.values()]
      .sort((a, b) => new Date(b.moved_at).getTime() - new Date(a.moved_at).getTime())
      .slice(0, SYNC_LIMIT)
      .map(toItem);
  }
  item(itemId: string) {
    const row = this.#rows.get(itemId);

    return row && toItem(row);
  }

  /**
   * Old ids of moved things in a request become their new home's: a plain id that moved away gets the new
   * home's suffix, a qualified id of the former home gets the new one, and one that moved here becomes plain.
   * Returns the redirects that applied.
   */
  rewrite(desc: DescMessage, message: Message): link.MovedItem[] {
    if (!this.#rows.size) return [];
    const self = nodeRef(this.self());
    const applied = new Map<string, link.MovedItem>();
    mapIds(desc, message, (value) => {
      const { id, node } = splitId(value);

      if (!PLAIN.test(id)) return value;
      const row = this.#rows.get(id);

      if (!row) return value;
      const home = nodeRef(row.home_node_id);

      if (home === (node ?? self)) return value;
      applied.set(id, toItem(row));

      return home === self ? id : qualifyId(id, row.home_node_id);
    });

    return [...applied.values()];
  }

  /** One id, rewritten like `rewrite` does (agent bus arguments). */
  map(value: string): string {
    const { id, node } = splitId(value);
    const row = PLAIN.test(id) ? this.#rows.get(id) : undefined;

    if (!row || nodeRef(row.home_node_id) === (node ?? nodeRef(this.self()))) return value;

    return row.home_node_id === this.self() ? id : qualifyId(id, row.home_node_id);
  }

  /** A partner's call on things that moved away from this computer: answered with where they are now. */
  refuse(method: DescMethod, request: Message) {
    if (!this.#rows.size) return;
    const self = this.self();
    const moved = new Map<string, link.MovedItem>();

    const check = (value: string) => {
      const row = PLAIN.test(value) ? this.#rows.get(value) : undefined;

      if (row && row.home_node_id !== self) moved.set(value, toItem(row));
    };

    mapIds(method.input, request, (value) => {
      check(value);

      return value;
    });

    if (method.name === "CallAgentBus") {
      const call = request as link.LinkedAgentCall;

      try {
        for (const value of Object.values(JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>))
          if (typeof value === "string") check(value);
      } catch {
        /* the home validates arguments */
      }
    }

    if (moved.size) throw new MovedError([...moved.values()]);
  }
}

const toItem = (row: Row) =>
  create(link.MovedItemSchema, {
    itemId: row.item_id,
    kind: row.kind,
    homeNodeId: row.home_node_id,
    homeName: row.home_name,
    fromNodeId: row.from_node_id,
    movedAtMs: BigInt(new Date(row.moved_at).getTime()),
  });
