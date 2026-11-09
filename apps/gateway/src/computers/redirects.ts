import { create, type DescMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { linkedMessage, mapIds, MovedError } from "./remote.ts";
import { Predicate, Schema } from "effect";
import type { ComputerStore } from "./store.ts";
import { followRedirects, recordRedirects, type RedirectRow as Row } from "./redirect-records.ts";

/**
 * Stage 8 of docs/linked-computers.md: where moved threads and bots live now. A moved thing keeps
 * its uuid, so an old id (`<uuid>` on its former home, `<uuid>~<old home>` elsewhere) resolves by
 * swapping the home. The table is filled by the two sides of a move, by `moved` frames from direct
 * partners and by "moved" answers of a former home (which also cross a relay).
 */
const PLAIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Redirects sent to a partner after each handshake: the most recent ones. */
const SYNC_LIMIT = 2000;

const valid = (item: link.MovedItem) =>
  PLAIN.test(item.itemId) && ["thread", "bot"].includes(item.kind) && /^[a-f0-9]{64}$/.test(item.homeNodeId);

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
    return this.#rows.get(itemId.toLowerCase());
  }
  get size() {
    return this.#rows.size;
  }

  /** Records where a thing lives now; an older notice never replaces a newer one. Returns whether it changed. */
  async record(item: link.MovedItem): Promise<boolean> {
    if (!this.#accepts(item)) return false;
    const at = new Date(Number(item.movedAtMs) || Date.now());

    const rows = await this.store.query<Row>(
      `INSERT INTO computer_redirects(owner_user_id,item_id,kind,home_node_id,home_name,from_node_id,moved_at)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT (owner_user_id,item_id) DO UPDATE SET kind=EXCLUDED.kind,home_node_id=EXCLUDED.home_node_id,
      home_name=EXCLUDED.home_name,from_node_id=EXCLUDED.from_node_id,moved_at=EXCLUDED.moved_at WHERE computer_redirects.moved_at<=EXCLUDED.moved_at RETURNING *`,
      [this.store.owner, item.itemId, item.kind, item.homeNodeId, item.homeName.slice(0, 120), item.fromNodeId, at],
    );

    if (rows[0]) this.#rows.set(rows[0].item_id, rows[0]);

    return Boolean(rows[0]);
  }

  #accepts(item: link.MovedItem) {
    if (!valid(item)) return false;
    const known = this.#rows.get(item.itemId.toLowerCase());
    const at = Number(item.movedAtMs) || Date.now();

    return (
      !known ||
      (new Date(known.moved_at).getTime() <= at &&
        (new Date(known.moved_at).getTime() < at || known.home_node_id !== item.homeNodeId))
    );
  }

  /** What a partner said moved. Only the former or the new home may say so, and nothing that lives here is moved by a notice. */
  async learn(sender: string, items: readonly link.MovedItem[]): Promise<link.MovedItem[]> {
    const trusted = items
      .slice(0, SYNC_LIMIT)
      .filter((item) => (sender === item.fromNodeId || sender === item.homeNodeId) && valid(item));

    const counts = new Map<string, number>();

    for (const item of trusted) {
      const id = item.itemId.toLowerCase();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const candidates = trusted.filter((item) => counts.get(item.itemId.toLowerCase())! > 1 || this.#accepts(item));
    const living = await this.#lives(candidates.filter((item) => item.homeNodeId !== this.self()));
    const learned: link.MovedItem[] = [];
    let pending = new Map<string, link.MovedItem>();

    const flush = async () => {
      if (!pending.size) return;
      const rows = await recordRedirects(this.store, [...pending.values()]);

      for (const row of rows) {
        this.#rows.set(row.item_id, row);
        learned.push(pending.get(row.item_id)!);
      }

      pending = new Map();
    };

    for (const item of candidates) {
      if (living.has(`${item.kind}:${item.itemId.toLowerCase()}`)) continue;

      // Duplicate IDs must observe the earlier commit before applying timestamp/home checks.
      if (pending.has(item.itemId.toLowerCase())) await flush();

      if (item.homeNodeId === this.self() && this.#rows.get(item.itemId.toLowerCase())?.home_node_id !== this.self())
        continue;

      if (!this.#accepts(item)) continue;
      pending.set(item.itemId.toLowerCase(), item);

      if (pending.size >= 128) await flush();
    }

    await flush();

    if (learned.length) await this.#follow(learned);

    return learned;
  }

  /** A thread or bot of this computer that has not moved away. */
  async #lives(items: readonly link.MovedItem[]) {
    const living = new Set<string>();

    for (const kind of ["thread", "bot"]) {
      const ids = [...new Set(items.flatMap((item) => (item.kind === kind ? [item.itemId] : [])))];

      if (!ids.length) continue;
      const table = kind === "bot" ? "bots" : "threads";

      const rows = await this.store.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) AND owner_user_id=$2::uuid AND moved_to IS NULL AND deleted_at IS NULL`,
        [ids, this.store.owner],
      );

      for (const row of rows) living.add(`${kind}:${row.id}`);
    }

    return living;
  }

  /** Agent bus references to a moved thing route to its new home (docs/linked-computers.md, stage 8). */
  async #follow(items: link.MovedItem[]) {
    if (items.length > 1 && new Set(items.map((item) => item.itemId.toLowerCase())).size === items.length) {
      try {
        await followRedirects(this.store, items);

        return;
      } catch {
        // Preserve best-effort per-item recovery when a single reference prevents the bulk update.
      }
    }

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
    const row = this.#rows.get(itemId.toLowerCase());

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
      const row = this.#rows.get(id.toLowerCase());

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
      const call = linkedMessage(link.LinkedAgentCallSchema, request);

      try {
        for (const value of Object.values(
          Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(call.argumentsJson || "{}")),
        ))
          if (Predicate.isString(value)) check(value);
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
