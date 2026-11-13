import { create, equals } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";

/** Domains an overview stream of this gateway pushes completely (`OverviewUpdate.feeds`). */
export const OWNER_FEEDS = ["bots", "connectors", "proxies", "updates"] as const;

/** Feeds that include linked computers: pushed only while every reachable one pushes them too. */
export const LINKED_FEEDS: readonly string[] = ["bots", "updates"];

/** Merges a burst of update center changes (a download reports often) into one notice. */
const UPDATES_MS = 250;

/** How often the feed compares cheap revisions while a client watches (ms). Mutations here nudge it at once. */
export const FEED_CHECK_MS = 2000;
const NUDGE_MS = 100;

/** The owner's bot journal clock (migration 0091): bots, messages, turns and tool calls bump it at commit. */
const BOT_CLOCK = `SELECT epoch::text AS id, revision::text AS revision FROM bot_view_clock WHERE owner_user_id = $1::uuid`;

const BOT_CHANGES = `SELECT DISTINCT bot_id::text AS id, '' AS revision FROM bot_view_changes
  WHERE owner_user_id = $1::uuid AND revision > $2::bigint AND revision <= $3::bigint`;

/** Waiting cards are outside the journal: per bot, its pending approvals and its threads' pending permissions. */
const BOT_CARDS = `SELECT a.bot_id::text AS id, 'a' || count(*) || '/' || max(a.created_at) AS revision FROM bot_approvals a
  JOIN bots b ON b.id = a.bot_id WHERE b.owner_user_id = $1::uuid AND a.status = 'pending' GROUP BY a.bot_id
  UNION ALL SELECT s.bot_id::text, 't' || count(*) || '/' || max(q.created_at) FROM bot_started_threads s
  JOIN interaction_requests q ON q.thread_id = s.thread_id JOIN bots b ON b.id = s.bot_id
  WHERE b.owner_user_id = $1::uuid AND q.kind = 'permission' AND q.status = 'pending' GROUP BY s.bot_id`;

const CONNECTOR_REVISION = `SELECT md5(coalesce((SELECT string_agg(concat_ws(':', a.id, a.revision, a.status, a.updated_at, a.error), ',' ORDER BY a.id)
  FROM connector_accounts a WHERE a.owner_user_id = $1::uuid), '') || '#' ||
  coalesce((SELECT string_agg(o.connector_type, ',' ORDER BY o.connector_type) FROM connector_oauth_apps o WHERE o.owner_user_id = $1::uuid), '')) AS revision`;

const PROXY_REVISION = `SELECT md5(coalesce(string_agg(concat_ws(':', p.id, p.revision, p.updated_at), ',' ORDER BY p.id), '')) AS revision
  FROM proxies p WHERE p.owner_user_id = $1::uuid`;

type Row = { id?: string; revision: string };

/**
 * Pushes bot summaries and connector/proxy invalidations to overview subscribers (docs/ui-api.md,
 * "Współdzielone odczyty"). While anyone watches, one cheap revision query per domain runs every 2 s for this
 * owner, so changes from the scheduler, agents, OAuth refreshes, configuration sync and other gateway
 * instances are seen too; mutations on this gateway nudge it at once. Only changed bots are read and sent.
 */
export class OwnerFeeds {
  #watchers = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #full = false;
  #clock: { epoch: string; revision: string } | undefined;
  #cards = new Map<string, string>();
  #views = new Map<string, bots.Bot>();
  #connectors: string | undefined;
  #proxies: string | undefined;
  #updates: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly core: GatewayCore,
    private readonly intervalMs = FEED_CHECK_MS,
  ) {}

  /** A subscriber started; returns its release. The feed runs while at least one watches. */
  attach(): () => void {
    this.#watchers++;

    if (this.#watchers === 1) this.#schedule(0);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.#watchers--;

      if (this.#watchers > 0) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      // A later subscriber starts from a fresh baseline: nothing missed meanwhile is replayed.
      this.#clock = undefined;
      this.#cards.clear();
      this.#views.clear();
      this.#connectors = undefined;
      this.#proxies = undefined;
    };
  }

  /** The update center changed: one `updates_changed` per burst, only while someone watches. */
  updatesChanged(): void {
    if (!this.#watchers || this.#updates) return;
    this.#updates = setTimeout(() => {
      this.#updates = undefined;

      if (this.#watchers) this.#publish({ case: "updatesChanged", value: true });
    }, UPDATES_MS);
  }

  /** Something changed here: compare now. `full` also compares every bot (connector grants, moves). */
  nudge(full = false): void {
    this.#full ||= full;

    if (this.#watchers) this.#schedule(NUDGE_MS);
  }

  #schedule(delay: number): void {
    if (this.#running) {
      this.#again = true;

      return;
    }

    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#run(), delay);
  }

  async #run(): Promise<void> {
    this.#timer = undefined;

    if (!this.#watchers) return;
    this.#running = this.#check().catch(() => {});
    await this.#running;
    this.#running = undefined;

    if (!this.#watchers) return;
    const again = this.#again;
    this.#again = false;
    this.#schedule(again ? NUDGE_MS : this.intervalMs);
  }

  #query(text: string, ...params: string[]): Promise<readonly Row[]> {
    const { runtime, userId } = this.core[coreState].options;

    return runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(text, [userId, ...params])).pipe(
        queryFamily("overview.feeds"),
        queryRpc,
      ),
    );
  }

  #publish(change: ui.OverviewUpdate["change"]): void {
    this.core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change }));
  }

  async #check(): Promise<void> {
    const full = this.#full;
    this.#full = false;

    const [clock, cards, connectors, proxies] = await Promise.all([
      this.#query(BOT_CLOCK),
      this.#query(BOT_CARDS),
      this.#query(CONNECTOR_REVISION),
      this.#query(PROXY_REVISION),
    ]);

    await this.#compareBots(
      { epoch: clock[0]?.id ?? "", revision: clock[0]?.revision ?? "0" },
      new Map(cards.map((row) => [row.id ?? "", row.revision])),
      full,
    );
    const connector = connectors[0]?.revision ?? "";
    const proxy = proxies[0]?.revision ?? "";

    if (this.#connectors !== undefined && this.#connectors !== connector)
      this.#publish({ case: "connectorsChanged", value: true });

    if (this.#proxies !== undefined && this.#proxies !== proxy) this.#publish({ case: "proxiesChanged", value: true });
    this.#connectors = connector;
    this.#proxies = proxy;
  }

  /** Bots named by the journal since the last check, or whose waiting cards changed. */
  async #changed(clock: { epoch: string; revision: string }, cards: Map<string, string>): Promise<Set<string>> {
    const previous = this.#clock!;
    const ids = new Set<string>();

    if (clock.revision !== previous.revision)
      for (const row of await this.#query(BOT_CHANGES, previous.revision, clock.revision)) ids.add(row.id ?? "");

    for (const id of new Set([...cards.keys(), ...this.#cards.keys()]))
      if (cards.get(id) !== this.#cards.get(id)) ids.add(id);

    return ids;
  }

  async #compareBots(clock: { epoch: string; revision: string }, cards: Map<string, string>, full: boolean) {
    const previous = this.#clock;

    // The first check is the baseline: clients read their own list when they start.
    if (!previous) {
      this.#clock = clock;
      this.#cards = cards;

      return;
    }

    // A new epoch (journal reset) names no bots: send all of them. A full check sends those that differ.
    const reset = clock.epoch !== previous.epoch;
    const all = full || reset;
    const changed = reset ? new Set<string>() : await this.#changed(clock, cards);
    this.#clock = clock;
    this.#cards = cards;

    if (!all && !changed.size) return;
    const list = await this.core.bots.list(true);
    const listed = new Set(list.map((bot) => bot.id));

    for (const bot of list) {
      const before = this.#views.get(bot.id);
      this.#views.set(bot.id, bot);

      if (changed.has(bot.id) || reset || (full && before && !equals(bots.BotSchema, before, bot)))
        this.#publish({ case: "bot", value: bot });
    }

    for (const id of [...changed, ...this.#views.keys()])
      if (!listed.has(id) && (changed.has(id) || this.#views.has(id))) {
        this.#views.delete(id);
        this.#publish({ case: "botRemoved", value: id });
      }
  }
}
