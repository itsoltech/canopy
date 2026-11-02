import { MentionKind, type bots } from "@open-agents/contracts";
import { fuzzyRank } from "@open-agents/domain";
import type { TriggerChar } from "#lib/features/mentions/editor.ts";
import type { MentionOption, MentionResults, MentionSourceSet } from "#lib/features/mentions/sources.svelte.ts";
import { INLINE_RENDERERS } from "#lib/features/mentions/kinds.ts";
import type { MentionData } from "#lib/features/mentions/kinds.ts";
import { botParticipant } from "./live.ts";
import { botMentionHtml } from "./mention-chip.ts";
import type { ParticipantView } from "./model.ts";

export const BOT_MENTION_TRIGGERS: ReadonlySet<TriggerChar> = new Set(["@"]);

/** Each @ group supplies its options; connectors will use the bot's enabled MCP connections. */
export interface BotMentionSource {
  search(query: string): readonly MentionOption[];
}
export interface BotMentionRegistry {
  readonly bots: readonly BotMentionSource[];
  readonly connectors: readonly BotMentionSource[];
}

export class BotMentionSources implements MentionSourceSet {
  readonly presentation = { "@": { label: "Bots", empty: "No bots match" } } as const;
  readonly registry: BotMentionRegistry;
  #bots: () => readonly bots.Bot[];
  #current: () => string;
  #query = $state<string>();

  constructor(list: () => readonly bots.Bot[], current: () => string, connectors: readonly BotMentionSource[] = []) {
    this.#bots = list;
    this.#current = current;
    this.registry = {
      bots: [{ search: (query) => fuzzyRank(query, this.#bots().filter((b) => b.id !== this.#current()), (b) => [b.configuration?.name ?? ""], 40).map(({ item, match }) => ({
        key: `bot:${item.id}`,
        data: { kind: MentionKind.BOT, name: item.id, label: item.configuration?.name ?? "Bot", path: "", source: "", isDir: false },
        title: item.configuration?.name ?? "Bot", detail: item.configuration?.model ?? "", group: "Bots", indices: match.indices,
      })) }],
      connectors,
    };
  }

  get results(): MentionResults {
    const query = this.#query;
    return { options: query === undefined ? [] : [...this.registry.bots, ...this.registry.connectors].flatMap((source) => source.search(query)), loading: false, error: undefined };
  }

  participant = (id: string, fallback = "Bot"): ParticipantView => {
    const bot = this.#bots().find((b) => b.id === id);
    return bot ? botParticipant(bot) : { id, kind: "bot", name: fallback };
  };
  renderMention = (mention: MentionData) => mention.kind === MentionKind.BOT
    ? botMentionHtml(mention, this.participant(mention.name, mention.label))
    : INLINE_RENDERERS.mention.html({ type: "mention", mention });
  query(char: TriggerChar, query: string): void { this.#query = char === "@" ? query : undefined; }
  close(): void { this.#query = undefined; }
}
