import { ItemStatus } from "@canopy/contracts";
import { dayKey } from "@canopy/domain/format";
import type { FeedInput, FeedRow } from "./feed.ts";
import { isTerminal } from "./timeline.ts";

type Context = { readonly lastDay: string; readonly withdrawn: readonly number[] };

type Build = (input: FeedInput, context?: Context) => FeedRow[];

interface Prefix {
  readonly input: FeedInput;
  readonly rows: FeedRow[];
  readonly ids: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  readonly results: FeedInput["results"];
  readonly context: Context;
  readonly lastSeq: bigint;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));

/** Reuse only an independent, immutable completed prefix. Interleaved/background work takes the full path. */
export class FeedPrefix {
  #prefix: Prefix | undefined;

  build(input: FeedInput, build: Build): FeedRow[] {
    let prefix = this.#prefix;

    if (!prefix || !this.matches(prefix, input)) prefix = this.#prefix = this.capture(input, build);

    if (!prefix) return build(input);

    return [...prefix.rows, ...build(this.tail(prefix, input), prefix.context)];
  }

  private tail(prefix: Prefix, input: FeedInput): FeedInput {
    return {
      ...input,
      entries: input.entries.slice(prefix.input.entries.length),
      turns: input.turns.slice(prefix.input.turns.length),
      notices: input.notices.slice(prefix.input.notices.length),
    };
  }

  private matches(prefix: Prefix, input: FeedInput): boolean {
    const before = prefix.input;

    if (
      !sameSet(before.openWork, input.openWork) ||
      !sameSet(before.openGroups ?? new Set(), input.openGroups ?? new Set()) ||
      !before.entries.every((entry, i) => input.entries[i] === entry) ||
      !before.turns.every(
        (turn, i) => input.turns[i] === turn && prefix.results.get(turn.id) === input.results.get(turn.id),
      ) ||
      !before.notices.every((notice, i) => input.notices[i] === notice)
    )
      return false;

    const tail = this.tail(prefix, input);

    return (
      tail.turns.every((turn) => !prefix.ids.has(turn.id) && turn.ordinal > before.turns.at(-1)!.ordinal) &&
      tail.entries.every((entry) => {
        const content = entry.item.content;

        return (
          !prefix.ids.has(entry.turnId) &&
          entry.firstSeq > prefix.lastSeq &&
          !prefix.itemIds.has(entry.item.parentItemId) &&
          !(content.case === "backgroundTask" && prefix.itemIds.has(content.value.sourceItemId))
        );
      }) &&
      tail.notices.every((notice) => !prefix.ids.has(notice.turnId) && notice.seq > prefix.lastSeq)
    );
  }

  private capture(input: FeedInput, build: Build): Prefix | undefined {
    // Keep the last turn in the live tail even when the snapshot contains only completed turns.
    const firstLive = input.turns.findIndex((turn) => !turn.withdrawn && !isTerminal(turn.status));
    const count = firstLive < 0 ? input.turns.length - 1 : firstLive;

    if (count < 1) return;
    const turns = input.turns.slice(0, count);

    if (turns.some((turn, i) => i > 0 && turn.ordinal <= turns[i - 1]!.ordinal)) return;
    const ids = new Set(turns.map((turn) => turn.id));
    const entries = input.entries.filter((entry) => ids.has(entry.turnId));
    const notices = input.notices.filter((notice) => ids.has(notice.turnId));
    const itemIds = new Set(entries.map((entry) => entry.id));

    // A running item can outlive its turn. Never freeze it or a dependency outside this prefix.
    if (
      entries.some((entry) => {
        const content = entry.item.content;

        return (
          entry.item.status === ItemStatus.IN_PROGRESS ||
          (entry.item.parentItemId && !itemIds.has(entry.item.parentItemId)) ||
          (content.case === "backgroundTask" && !itemIds.has(content.value.sourceItemId))
        );
      })
    )
      return;

    const before = {
      ...input,
      entries,
      turns,
      notices,
      openWork: new Set(input.openWork),
      openGroups: new Set(input.openGroups),
    };

    const prefix: Prefix = {
      input: before,
      rows: [],
      ids,
      itemIds,
      results: new Map(input.results),
      context: {
        lastDay: "",
        withdrawn: turns.filter((turn) => turn.withdrawn).map((turn) => turn.ordinal),
      },
      lastSeq: [...entries.map((entry) => entry.firstSeq), ...notices.map((notice) => notice.seq)].reduce(
        (last, seq) => (seq > last ? seq : last),
        -1n,
      ),
    };

    if (!this.matches(prefix, input)) return;

    const rows = build(before);

    const days = rows.flatMap((row) =>
      row.kind === "timeline" && row.row.kind === "turn-start"
        ? [dayKey(row.row.turn.startedAt ?? row.row.turn.queuedAt)]
        : [],
    );

    return { ...prefix, rows, context: { ...prefix.context, lastDay: days.filter(Boolean).at(-1) ?? "" } };
  }
}
