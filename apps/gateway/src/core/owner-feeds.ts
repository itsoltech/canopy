import { create, equals } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { botThreadConnection } from "../store/module-access.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import { executingBotIds, listBotSummaries } from "./bot-execution.ts";

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
const botCards = (owner: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (
      sql,
    ) => sql<Row>`SELECT a.bot_id::text AS id, 'a' || count(*) || '/' || max(a.created_at) AS revision FROM bot_approvals a
  JOIN bots b ON b.id = a.bot_id WHERE b.owner_user_id = ${owner}::uuid AND a.status = 'pending' GROUP BY a.bot_id
  UNION ALL SELECT s.bot_id::text, 't' || count(*) || '/' || max(q.created_at) FROM bot_started_threads s
  JOIN interaction_requests q ON q.thread_id = s.thread_id JOIN bots b ON b.id = s.bot_id
  WHERE b.owner_user_id = ${owner}::uuid AND ${botThreadConnection(sql, owner)} AND q.kind = 'permission' AND q.status = 'pending' GROUP BY s.bot_id`,
  ).pipe(queryFamily("overview.feeds"), queryRpc);

const CONNECTOR_REVISION = `SELECT md5(coalesce((SELECT string_agg(concat_ws(':', a.id, a.revision, a.status, a.updated_at, a.error), ',' ORDER BY a.id)
  FROM connector_accounts a WHERE a.owner_user_id = $1::uuid), '') || '#' ||
  coalesce((SELECT string_agg(o.connector_type, ',' ORDER BY o.connector_type) FROM connector_oauth_apps o WHERE o.owner_user_id = $1::uuid), '') || '#' ||
  coalesce((SELECT string_agg(concat_ws(':', m.id, m.revision,
    m.enabled AND m.status NOT IN ('needs_authorization','needs_reconnect','disconnected')), ',' ORDER BY m.id)
    FROM messenger_accounts m WHERE m.owner_user_id = $1::uuid AND m.connector_account_id IS NOT NULL AND m.deleted_at IS NULL), '')) AS revision`;

// Include usedBy references and worker names; account read time alone does not change the list.
const PROXY_REVISION = `SELECT md5(coalesce(string_agg(concat_ws(':', p.id, p.revision, p.updated_at,
    md5((p.management_status - 'checkedAt')::text), p.account_plans::text,
    (SELECT string_agg(i.harness || '/' || i.id, ',' ORDER BY i.harness, i.id)
      FROM provider_instances i WHERE i.proxy_id = p.id),
    (SELECT string_agg(w.harness || '/' || w.instance_id || ' on ' || d.name, ',' ORDER BY w.harness, w.instance_id, w.worker_id)
      FROM provider_instance_workers w JOIN workers d ON d.id = w.worker_id WHERE w.proxy_id = p.id)),
    ',' ORDER BY p.id), '')) AS revision
  FROM proxies p WHERE p.owner_user_id = $1::uuid`;

// Notices can be dismissed without advancing the configuration clock. Include their open set too.
const CONFIG_REVISION = `SELECT concat_ws(':',
  (SELECT epoch::text || '/' || revision FROM config_clock WHERE owner_user_id=$1::uuid),
  (SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) FROM config_history
    WHERE owner_user_id=$1::uuid AND state='open' AND superseded_at>now()-interval '90 days')) AS revision`;

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
  #executing: ReadonlySet<string> = new Set();
  #views = new Map<string, bots.Bot>();
  #connectors: string | undefined;
  #proxies: string | undefined;
  #config: string | undefined;
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
      this.#executing = new Set();
      this.#views.clear();
      this.#connectors = undefined;
      this.#proxies = undefined;
      this.#config = undefined;
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

    const { runtime, userId } = this.core[coreState].options;

    const [clock, cards, executing, connectors, proxies, config] = await Promise.all([
      this.#query(BOT_CLOCK),
      runtime.runPromise(botCards(userId)),
      executingBotIds(this.core),
      this.#query(CONNECTOR_REVISION),
      this.#query(PROXY_REVISION),
      this.#query(CONFIG_REVISION),
    ]);

    await this.#compareBots(
      { epoch: clock[0]?.id ?? "", revision: clock[0]?.revision ?? "0" },
      new Map(cards.map((row) => [row.id ?? "", row.revision])),
      executing,
      full,
    );
    const connector = connectors[0]?.revision ?? "";
    const proxy = proxies[0]?.revision ?? "";

    if (this.#connectors !== undefined && this.#connectors !== connector)
      this.#publish({ case: "connectorsChanged", value: true });

    if (this.#proxies !== undefined && this.#proxies !== proxy) this.#publish({ case: "proxiesChanged", value: true });
    this.#connectors = connector;
    this.#proxies = proxy;
    const configuration = config[0]?.revision ?? "";

    if (this.#config !== undefined && this.#config !== configuration)
      this.#publish({ case: "linkedReadCompleted", value: "GetComputers" });
    this.#config = configuration;
  }

  /** Bots named by the journal, or whose waiting cards or live execution changed. */
  async #changed(
    clock: { epoch: string; revision: string },
    cards: Map<string, string>,
    executing: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const previous = this.#clock!;
    const ids = new Set<string>();

    if (clock.revision !== previous.revision)
      for (const row of await this.#query(BOT_CHANGES, previous.revision, clock.revision)) ids.add(row.id ?? "");

    for (const id of new Set([...cards.keys(), ...this.#cards.keys()]))
      if (cards.get(id) !== this.#cards.get(id)) ids.add(id);

    for (const id of new Set([...executing, ...this.#executing]))
      if (executing.has(id) !== this.#executing.has(id)) ids.add(id);

    return ids;
  }

  async #compareBots(
    clock: { epoch: string; revision: string },
    cards: Map<string, string>,
    executing: ReadonlySet<string>,
    full: boolean,
  ) {
    // Start the feed with authoritative summaries, including a false value if a client read just before a finish.
    const reset = clock.epoch !== this.#clock?.epoch;
    const changed = reset ? new Set<string>() : await this.#changed(clock, cards, executing);

    if (reset || full || changed.size) await this.#publishBots(reset, full, changed, executing);
    this.#clock = clock;
    this.#cards = cards;
    this.#executing = executing;
  }

  async #publishBots(reset: boolean, full: boolean, changed: Set<string>, executing: ReadonlySet<string>) {
    const list = await listBotSummaries(this.core, true, executing);
    const listed = new Set(list.map((bot) => bot.id));

    for (const bot of list) {
      if (!reset && !full && !changed.has(bot.id)) continue;
      const before = this.#views.get(bot.id);

      // Conversation and tool writes advance the journal even when the ListBots summary stays the same.
      // Older web clients also apply conversation replies to their list. Those replies omit pendingApproval.
      const restoreCard = changed.has(bot.id) && !!bot.pendingApproval;

      if (!reset && !restoreCard && before && equals(bots.BotSchema, before, bot)) continue;
      this.#views.set(bot.id, bot);
      this.#publish({ case: "bot", value: bot });
    }

    for (const id of new Set([...changed, ...this.#views.keys()]))
      if (!listed.has(id)) {
        this.#views.delete(id);
        this.#publish({ case: "botRemoved", value: id });
      }
  }
}
