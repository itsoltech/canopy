import type { ThreadEventInit } from "../../journal/index.ts";
import type { ServerNotification, v2 } from "@canopy/codex-protocol";
import { addUsage, emptyUsage, reportedUsd, tokenCount, tokenFields, type ConsumedUsage } from "../token-usage.ts";
import type { OpenAiPricingCatalog } from "../pricing/openai-catalog.ts";
import { quoteOpenAi, validOpenAiUsage } from "../pricing/openai-rates.ts";
import { ResponseQuotes } from "../pricing/response-quotes.ts";

export function codexTokens(usage: v2.TokenUsageBreakdown): ConsumedUsage {
  return {
    ...emptyUsage(),
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cachedInputTokens: tokenCount(usage.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(usage.cacheWriteInputTokens),
    reasoningOutputTokens: tokenCount(usage.reasoningOutputTokens),
  };
}

interface ModelUsage {
  responses: Set<string>;
  costKnown: boolean;
  raw: ConsumedUsage;
  cumulative: ConsumedUsage;
  quotes: ResponseQuotes;
}

/** Codex reports the response cost as a decimal USD amount. Missing or malformed values stay unknown. */
function responseCost(amount: string | null | undefined): number | undefined {
  if (!amount || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(amount)) return undefined;

  return reportedUsd(Number(amount));
}

/** Session counters are differenced before assigning consumption to a platform turn and model. */
export class CodexConsumedUsage {
  readonly #turns = new Map<string, Map<string, ModelUsage>>();
  readonly #models = new Map<string, string>();
  readonly #requestedTiers = new Map<string, string>();
  #requestedServiceTier = "";
  #previous: ConsumedUsage | undefined;
  #model = "";
  #activeTurn = "";
  readonly #observed = new WeakMap<v2.RawResponseCompletedNotification | v2.ThreadTokenUsage, number>();

  constructor(readonly pricing?: OpenAiPricingCatalog) {}

  /** Called in notification order before synchronous mapping; only live owned usage needs prices. */
  async prepare(event: ServerNotification, owned: boolean): Promise<void> {
    if (!owned || (event.method !== "rawResponse/completed" && event.method !== "thread/tokenUsage/updated")) return;

    if (event.method === "rawResponse/completed" && !event.params.usage) return;
    this.#observedAt(event.method === "rawResponse/completed" ? event.params : event.params.tokenUsage);
    const model = this.#models.get(event.params.turnId) ?? this.#model;
    await this.pricing?.prepare(model);
  }

  #observedAt(usage: v2.RawResponseCompletedNotification | v2.ThreadTokenUsage): number {
    const known = this.#observed.get(usage);

    if (known !== undefined) return known;
    const now = this.pricing?.now() ?? Date.now();
    this.#observed.set(usage, now);

    return now;
  }

  setModel(model: string, turnId?: string): void {
    if (turnId) this.#models.set(turnId, model);
    else this.#model = model;
  }

  setRequestedServiceTier(tier: string, turnId?: string): void {
    if (turnId && !this.#requestedTiers.has(turnId)) this.#requestedTiers.set(turnId, tier);
    else if (!turnId) this.#requestedServiceTier = tier;
  }

  beginTurn(turnId: string): void {
    this.#activeTurn = turnId;

    if (!this.#requestedTiers.has(turnId)) this.#requestedTiers.set(turnId, this.#requestedServiceTier);
    // Advance the inherited choice in native turn order, after buffered earlier provider wakeups.
    this.#requestedServiceTier = this.#requestedTiers.get(turnId) ?? this.#requestedServiceTier;

    if (!this.#models.has(turnId)) this.#models.set(turnId, this.#model);
    this.#model = this.#models.get(turnId) ?? this.#model;
  }

  #turn(turnId: string): ModelUsage {
    if (!this.#requestedTiers.has(turnId)) this.#requestedTiers.set(turnId, this.#requestedServiceTier);
    let models = this.#turns.get(turnId);

    if (!models) {
      models = new Map();
      this.#turns.set(turnId, models);
    }

    const model = this.#models.get(turnId) ?? this.#model;
    let turn = models.get(model);

    if (!turn) {
      turn = {
        responses: new Set(),
        costKnown: true,
        raw: { ...emptyUsage(), model },
        cumulative: emptyUsage(),
        quotes: new ResponseQuotes(),
      };
      models.set(model, turn);
    }

    return turn;
  }

  cumulative(turnId: string, usage: v2.ThreadTokenUsage, owned: boolean): ConsumedUsage[] {
    if (this.#activeTurn && this.#activeTurn !== turnId) return [];

    const total = codexTokens(usage.total);
    const last = codexTokens(usage.last);
    const delta = emptyUsage();
    const previous = this.#previous;
    const monotone = previous && tokenFields.every((key) => total[key] >= previous[key]);
    const proven = !!monotone || tokenFields.every((key) => total[key] === last[key]);

    for (const key of tokenFields)
      delta[key] = this.#previous && total[key] >= this.#previous[key] ? total[key] - this.#previous[key] : last[key];

    this.#previous = total;

    // Resume/fork can report historical turns: establish the baseline without recording consumption.
    if (!owned) return [];
    const turn = this.#turn(turnId);

    if (tokenFields.some((key) => delta[key] > 0n)) {
      const single =
        proven &&
        validOpenAiUsage(usage.last) &&
        validOpenAiUsage(usage.total) &&
        tokenFields.every((key) => delta[key] === last[key]);

      const rates = this.pricing?.get(turn.raw.model ?? "");
      const tier = this.#requestedTiers.get(turnId) ?? this.#requestedServiceTier;
      turn.quotes.add(
        "counter",
        delta,
        single && rates ? quoteOpenAi(rates, usage.last, tier, this.#observedAt(usage)) : undefined,
        single,
      );
    }

    addUsage(turn.cumulative, delta);

    return this.snapshots(turnId);
  }

  response(params: v2.RawResponseCompletedNotification, owned: boolean): ConsumedUsage[] {
    if (!owned) return [];

    if ([...(this.#turns.get(params.turnId)?.values() ?? [])].some((turn) => turn.responses.has(params.responseId)))
      return [];
    const turn = this.#turn(params.turnId);
    turn.responses.add(params.responseId);

    if (params.usage) addUsage(turn.raw, codexTokens(params.usage));
    const rates = this.pricing?.get(turn.raw.model ?? "");
    const tier = this.#requestedTiers.get(params.turnId) ?? this.#requestedServiceTier;
    turn.quotes.add(
      "raw",
      params.usage ? codexTokens(params.usage) : emptyUsage(),
      rates && params.usage ? quoteOpenAi(rates, params.usage, tier, this.#observedAt(params)) : undefined,
      !!params.usage && validOpenAiUsage(params.usage),
    );
    const cost = responseCost(params.usageMetadata?.amount);

    if (cost === undefined) turn.costKnown = false;
    else {
      turn.raw.reportedCostUsd = reportedUsd((turn.raw.reportedCostUsd ?? 0) + cost);

      if (turn.raw.reportedCostUsd === undefined) turn.costKnown = false;
    }

    return this.snapshots(params.turnId);
  }

  observe(event: ServerNotification, owned: boolean): ConsumedUsage[] {
    switch (event.method) {
      case "thread/tokenUsage/updated":
        return this.cumulative(event.params.turnId, event.params.tokenUsage, owned);
      case "rawResponse/completed":
        return this.response(event.params, owned);
      case "model/rerouted":
        this.setModel(event.params.toModel, event.params.turnId);

        return [];
      default:
        return [];
    }
  }

  events(
    notification: ServerNotification,
    owned: (turnId: string) => boolean,
    event: (turnId: string, body: ThreadEventInit["body"]) => ThreadEventInit,
  ): ThreadEventInit[] | undefined {
    if (notification.method === "model/rerouted") {
      this.setModel(notification.params.toModel, notification.params.turnId);

      return [event(notification.params.turnId, undefined)];
    }

    if (notification.method === "rawResponse/completed") {
      const { turnId } = notification.params;
      const snapshots = this.response(notification.params, owned(turnId));

      return snapshots.length
        ? snapshots.map((usage) => event(turnId, { case: "usageUpdated", value: { usage } }))
        : [event(turnId, undefined)];
    }

    if (notification.method !== "thread/tokenUsage/updated") return undefined;
    const { turnId, tokenUsage } = notification.params;
    const snapshots = this.cumulative(turnId, tokenUsage, owned(turnId));

    return [
      ...snapshots
        .filter(() => snapshots.length > 1)
        .map((usage) => event(turnId, { case: "usageUpdated", value: { usage } })),
      event(turnId, {
        case: "usageUpdated",
        value: {
          ...(snapshots.length === 1 && { usage: snapshots[0] }),
          contextUsage: {
            usedTokens: tokenCount(tokenUsage.last.totalTokens),
            ...(tokenUsage.modelContextWindow != null &&
              tokenUsage.modelContextWindow > 0 && {
                limitTokens: tokenCount(tokenUsage.modelContextWindow),
              }),
          },
        },
      }),
    ];
  }

  snapshots(turnId: string): ConsumedUsage[] {
    return [...(this.#turns.get(turnId)?.values() ?? [])].map((turn) => {
      const result = { ...turn.raw };
      const uncovered = tokenFields.some((key) => turn.cumulative[key] > turn.raw[key]);
      const counterCovers = tokenFields.every((key) => turn.cumulative[key] >= turn.raw[key]);

      const quotes =
        counterCovers && turn.quotes.rawValid && turn.quotes.counter.usd !== undefined
          ? turn.quotes.counter
          : !uncovered
            ? turn.quotes.raw
            : undefined;

      result.estimatedCostUsd = quotes?.usd;
      const version = quotes?.version;

      if (version) result.pricingVersion = version;

      // Both notifications describe the same responses; never add the two sources together.
      for (const key of tokenFields)
        result[key] = result[key] > turn.cumulative[key] ? result[key] : turn.cumulative[key];

      if (!turn.costKnown || uncovered) delete result.reportedCostUsd;

      result.requestedServiceTier = this.#requestedTiers.get(turnId) ?? this.#requestedServiceTier;

      return result;
    });
  }
}
