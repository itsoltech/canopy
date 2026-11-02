import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemSchema, ItemStatus, ThreadEventSchema, ui, type Item } from "@open-agents/contracts";
import { reduceItem } from "@open-agents/domain/items";
import { compileModule } from "svelte/compiler";
import { coalesceDeltas } from "../src/lib/server/coalesce.ts";
import { idleCut, lineCut } from "../src/lib/shared/ui/streaming/line-buffer.ts";
import { lexMarkdown, shareTokens } from "../src/lib/shared/ui/markdown/tokens.ts";

// Rune modules (`*.svelte.ts`) compiled for the client runtime, so effects and timers run here too.
Bun.plugin({
  name: "svelte-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(js, { filename: path, generate: "client" }).js.code, loader: "js" };
    });
  },
});

type Reveal = typeof import("../src/lib/shared/ui/streaming/line-reveal.svelte.ts");
type Source<T> = { v: T };
/** Svelte's client runtime (the package resolves to its server build outside a browser). */
let $: {
  state: <T>(value: T) => Source<T>;
  set: <T>(source: Source<T>, value: T) => void;
  get: <T>(source: Source<T>) => T;
  effect_root: (fn: () => void) => () => void;
  flushSync: () => void;
};
let LineReveal: Reveal["LineReveal"];
beforeAll(async () => {
  const client = Bun.resolveSync("svelte/internal/client", import.meta.dir);
  $ = { ...(await import(client)), flushSync: (await import(client.replace(/internal\/client\/index\.js$/, "index-client.js"))).flushSync };
  ({ LineReveal } = await import("../src/lib/shared/ui/streaming/line-reveal.svelte.ts"));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("line cut while streaming", () => {
  test("shows up to the last line break, never less than what was revealed", () => {
    expect(lineCut("first line\nsecond par", 0)).toBe("first line\n".length);
    expect(lineCut("no break yet", 0)).toBe(0);
    expect(lineCut("no break yet", 3)).toBe(3);
    expect(lineCut("short", 99)).toBe(5);
  });

  test("a table header waits for its delimiter row, then the table shows at once", () => {
    const header = "Intro\n\n| a | b |\n";
    expect(header.slice(0, lineCut(header, 0))).toBe("Intro\n\n");
    const table = header + "|---|---|\n";
    expect(lineCut(table, 0)).toBe(table.length);
    // A row after the delimiter shows as soon as it is complete.
    expect(lineCut(table + "| 1 | 2 |\n", 0)).toBe(table.length + "| 1 | 2 |\n".length);
  });

  test("idle flush stops at the last whole word, or takes everything when there is none", () => {
    const text = "A long line that is still arri";
    expect(text.slice(0, idleCut(text, 0))).toBe("A long line that is still ");
    expect(idleCut("Hello", 0)).toBe(5);
    // Nothing new up to a word break: the rest goes out.
    expect(idleCut("A long line that is still arri", "A long line that is still ".length)).toBe(text.length);
  });

  test("idle flush keeps a partial fence or table row back (it would show as raw markup)", () => {
    expect(idleCut("Text\n```t", 5)).toBe(5);
    expect(idleCut("Text\n| a | b", 5)).toBe(5);
  });
});

describe("LineReveal", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  function setup(idleMs = 40) {
    const text = $.state("");
    const streaming = $.state(true);
    let reveal!: InstanceType<typeof LineReveal>;
    cleanup = $.effect_root(() => {
      reveal = new LineReveal(
        () => $.get(text),
        () => $.get(streaming),
        idleMs,
      );
    });
    const flush = () => $.flushSync();
    return {
      reveal,
      push(chunk: string) {
        $.set(text, $.get(text) + chunk);
        flush();
      },
      end() {
        $.set(streaming, false);
        flush();
      },
      flush,
    };
  }

  test("advances per line; a partial line follows after the idle pause", async () => {
    const s = setup();
    s.push("Hello wor");
    expect(s.reveal.text).toBe("");
    s.push("ld\nNext li");
    expect(s.reveal.text).toBe("Hello world\n");
    await wait(70);
    s.flush();
    expect(s.reveal.text).toBe("Hello world\nNext ");
    s.push("ne\n");
    expect(s.reveal.text).toBe("Hello world\nNext line\n");
  });

  test("a one-line answer shows after the idle pause without waiting for a line break", async () => {
    const s = setup();
    s.push("Ok");
    expect(s.reveal.text).toBe("");
    await wait(70);
    s.flush();
    expect(s.reveal.text).toBe("Ok");
  });

  test("completion shows the exact full text at once", () => {
    const s = setup(10_000);
    s.push("Line one\nand a partial tail with **bold");
    expect(s.reveal.text).toBe("Line one\n");
    s.end();
    expect(s.reveal.text).toBe("Line one\nand a partial tail with **bold");
  });
});

// --- Delta coalescing ----------------------------------------------------------------------------------
let seq = 0n;
const update = (body: ui.ThreadEventUpdate["event"] extends infer E ? (E extends { body: infer B } ? B : never) : never): ui.ThreadUpdate =>
  create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: ++seq, event: create(ThreadEventSchema, { threadId: "t", turnId: "turn", rawJson: "{}", body }) } } });
const delta = (itemId: string, chunk: string, field = ItemDeltaField.TEXT) => update({ case: "itemDelta", value: { itemId, field, chunk } });
const started = (itemId: string) =>
  update({ case: "itemStarted", value: { item: create(ItemSchema, { itemId, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { text: "", phase: "" } } }) } });
const completed = (itemId: string, text: string) =>
  update({ case: "itemCompleted", value: { item: create(ItemSchema, { itemId, status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { text, phase: "" } } }) } });

async function* timed(steps: readonly (ui.ThreadUpdate | number)[]): AsyncGenerator<ui.ThreadUpdate> {
  for (const step of steps) {
    if (typeof step === "number") await wait(step);
    else yield step;
  }
}
async function collect(source: AsyncIterable<ui.ThreadUpdate>): Promise<ui.ThreadUpdate[]> {
  const out: ui.ThreadUpdate[] = [];
  for await (const u of source) out.push(u);
  return out;
}
const describeUpdate = (u: ui.ThreadUpdate) => {
  const body = u.change.case === "event" ? u.change.value.event?.body : undefined;
  return body?.case === "itemDelta" ? `delta:${body.value.itemId}:${body.value.chunk}` : (body?.case ?? u.change.case);
};
const project = (updates: ui.ThreadUpdate[]) => {
  let item: Item | undefined;
  for (const u of updates) if (u.change.case === "event" && u.change.value.event) item = reduceItem(item, u.change.value.event.body);
  return item;
};

describe("delta coalescing in the SSE relay", () => {
  test("merges token deltas into one per line, before any other update, in order", async () => {
    const input = [started("m"), delta("m", "Hel"), delta("m", "lo"), delta("m", " world\nNe"), delta("m", "xt"), completed("m", ""), delta("m", "late")];
    const out = await collect(coalesceDeltas(timed(input), { windowMs: 1000 }));
    expect(out.map(describeUpdate)).toEqual(["itemStarted", "delta:m:Hello world\nNe", "delta:m:xt", "itemCompleted", "delta:m:late"]);
    // The projected item is the same as from the raw stream.
    expect(toBinary(ItemSchema, project(out)!)).toEqual(toBinary(ItemSchema, project(input)!));
    expect(project(out)?.content.value).toMatchObject({ text: "Hello world\nNext" });
  });

  test("a partial line goes out after the window; other items and fields are not merged", async () => {
    const input = [delta("a", "x"), delta("b", "y"), delta("b", "z", ItemDeltaField.SUMMARY), delta("b", "1"), 60, delta("b", "2")];
    const out = await collect(coalesceDeltas(timed(input), { windowMs: 20 }));
    expect(out.map(describeUpdate)).toEqual(["delta:a:x", "delta:b:y", "delta:b:z", "delta:b:1", "delta:b:2"]);
  });

  test("a held delta goes out on its window even while the source is quiet", async () => {
    const times: number[] = [];
    const start = performance.now();
    for await (const u of coalesceDeltas(timed([delta("m", "a"), delta("m", "b"), 150, delta("m", "c")]), { windowMs: 30 })) {
      times.push(performance.now() - start);
      if (describeUpdate(u) === "delta:m:ab") expect(times[0]).toBeLessThan(120);
    }
    expect(times.length).toBe(2);
  });

  test("a merged delta keeps the last seq and drops the single delta's raw payload", async () => {
    const [a, b] = [delta("m", "a"), delta("m", "b\n")];
    const [merged] = await collect(coalesceDeltas(timed([a, b])));
    expect(merged?.change.case === "event" && merged.change.value.seq).toBe(b.change.case === "event" ? b.change.value.seq : -1n);
    expect(merged?.change.case === "event" && merged.change.value.event?.rawJson).toBe("");
    // A lone delta passes through untouched.
    const single = delta("m", "solo\n");
    expect((await collect(coalesceDeltas(timed([single]))))[0]).toBe(single);
  });
});

// --- Markdown block memoization ---------------------------------------------------------------------------
describe("markdown token sharing", () => {
  test("blocks that did not change keep their object; the growing one is new", () => {
    const first = shareTokens([], lexMarkdown("# Title\n\nPara one.\n\n- a\n- b\n"));
    const second = shareTokens(first, lexMarkdown("# Title\n\nPara one.\n\n- a\n- b\n- c\n"));
    expect(second[0]).toBe(first[0]!);
    expect(second[2]).toBe(first[2]!);
    const [listBefore, listAfter] = [first.at(-1), second.at(-1)] as { items: unknown[] }[];
    expect(listAfter).not.toBe(listBefore);
    // Inside the list only the new item is new.
    expect(listAfter!.items[0]).toBe(listBefore!.items[0]);
    expect(listAfter!.items[1]).not.toBe(listBefore!.items[1]); // "- b\n" is no longer the last item's raw
    expect(listAfter!.items.length).toBe(3);
  });

  test("an open fence is a code block that grows; table rows that did not change are shared", () => {
    const code = shareTokens([], lexMarkdown("Intro\n\n```ts\nconst a = 1;\n"));
    expect(code.at(-1)).toMatchObject({ type: "code", text: "const a = 1;" });
    const t1 = shareTokens([], lexMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n"));
    const t2 = shareTokens(t1, lexMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"));
    const [rows1, rows2] = [(t1[0] as { rows: unknown[] }).rows, (t2[0] as { rows: unknown[] }).rows];
    expect(rows2[0]).toBe(rows1[0]);
    expect(rows2.length).toBe(2);
  });

  test("a list item whose list turns loose is not reused", () => {
    const tight = shareTokens([], lexMarkdown("- a\n- b\n"));
    const loose = shareTokens(tight, lexMarkdown("- a\n- b\n\n- c\n"));
    const [before, after] = [(tight[0] as { items: { loose: boolean }[] }).items, (loose[0] as { items: { loose: boolean }[] }).items];
    expect(after[0]!.loose).toBe(true);
    expect(after[0]).not.toBe(before[0]);
  });
});
