import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider, UserInputSchema, ui, type Mention } from "@canopy/contracts";
import { fuzzyMatch, fuzzyRank } from "./fuzzy.ts";
import { checkMentions, composeMessage, MentionError, mentionLabel, mentionPlaceholder } from "./mentions.ts";

const THREAD = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** Builds a message from parts: strings are text, objects are mentions placed at their position. */
function message(...parts: (string | { kind: MentionKind; name: string; label?: string; path?: string; source?: string })[]): { text: string; mentions: Mention[] } {
  let text = "";
  const mentions: Mention[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const placeholder = mentionPlaceholder({ kind: part.kind, name: part.name, label: part.label ?? "" });
    mentions.push(create(MentionSchema, { ...part, start: text.length, end: text.length + placeholder.length }));
    text += placeholder;
  }
  return { text, mentions };
}

const slices = (text: string, mentions: readonly Mention[]) => mentions.map((m) => text.slice(m.start, m.end));

describe("placeholders and labels", () => {
  test("each kind starts with its trigger", () => {
    expect(mentionPlaceholder({ kind: MentionKind.COMMAND, name: "review", label: "" })).toBe("/review");
    expect(mentionPlaceholder({ kind: MentionKind.SKILL, name: "transitions-dev", label: "Transitions Dev" })).toBe("$transitions-dev");
    expect(mentionPlaceholder({ kind: MentionKind.PLUGIN, name: "apple-music", label: "Apple Music" })).toBe("$apple-music");
    expect(mentionPlaceholder({ kind: MentionKind.FILE, name: "docs/notatka.md", label: "" })).toBe("@docs/notatka.md");
    expect(mentionPlaceholder({ kind: MentionKind.THREAD, name: THREAD, label: "Uwzględnij 3 zadania" })).toBe("#Uwzględnij 3 zadania");
  });

  test("chips show display names, file names and titles", () => {
    expect(mentionLabel({ kind: MentionKind.FILE, name: "docs/notatka-z-lekcji.md", label: "" })).toBe("notatka-z-lekcji.md");
    expect(mentionLabel({ kind: MentionKind.SKILL, name: "transitions-dev", label: "Transitions Dev" })).toBe("Transitions Dev");
  });
});

describe("checkMentions", () => {
  test("sorts and accepts a well-formed message", () => {
    const { text, mentions } = message("To jest skill: ", { kind: MentionKind.SKILL, name: "transitions-dev" }, " plik: ", { kind: MentionKind.FILE, name: "a b/ż.md" });
    const checked = checkMentions(text, [...mentions].reverse());
    expect(slices(text, checked)).toEqual(["$transitions-dev", "@a b/ż.md"]);
  });

  test.each([
    ["outside the text", (m: Mention) => ({ ...m, end: 999 })],
    ["empty range", (m: Mention) => ({ ...m, end: m.start })],
    ["without its trigger", (m: Mention) => ({ ...m, start: m.start + 1 })],
    ["without a kind", (m: Mention) => ({ ...m, kind: MentionKind.UNSPECIFIED })],
  ])("refuses a mention %s", (_, change) => {
    const { text, mentions } = message("x ", { kind: MentionKind.SKILL, name: "s" }, " y");
    const [first] = mentions;
    expect(() => checkMentions(text, [create(MentionSchema, change(first!))])).toThrow(MentionError);
  });

  test("refuses overlaps, two commands, paths leaving the folder and non-uuid threads", () => {
    const a = message({ kind: MentionKind.COMMAND, name: "a" }, " ", { kind: MentionKind.COMMAND, name: "b" });
    expect(() => checkMentions(a.text, a.mentions)).toThrow("one command");
    const b = message({ kind: MentionKind.SKILL, name: "s" });
    expect(() => checkMentions(b.text, [...b.mentions, ...b.mentions])).toThrow("overlaps");
    for (const name of ["../etc/passwd", "a/../../b", "/etc/passwd", "C:/x", "a\\b"]) {
      const c = message({ kind: MentionKind.FILE, name });
      expect(() => checkMentions(c.text, c.mentions)).toThrow("inside the thread's folder");
    }
    const d = message({ kind: MentionKind.THREAD, name: "not-a-uuid", label: "x" });
    expect(() => checkMentions(d.text, d.mentions)).toThrow("thread id");
  });
});

describe("composeMessage", () => {
  test("Codex: the text stays as written, threads get a note and the ranges follow it", () => {
    const { text, mentions } = message("Use ", { kind: MentionKind.SKILL, name: "imagegen" }, " and see ", { kind: MentionKind.THREAD, name: THREAD, label: "Plan" });
    const out = composeMessage(Provider.CODEX, text, mentions);
    expect(out.message).toBe(text);
    expect(out.note).toBe(`[canopy] The user mentioned another thread; read it with get_thread / read_thread when you need it:\n- "Plan" (thread_id: ${THREAD})`);
    expect(out.text).toBe(`${out.note}\n\n${text}`);
    expect(slices(out.text, out.mentions)).toEqual(["$imagegen", "#Plan"]);
  });

  test("Claude: a command in the middle moves to the start and the rest closes up", () => {
    const { text, mentions } = message("please  ", { kind: MentionKind.COMMAND, name: "review" }, "  the ", { kind: MentionKind.FILE, name: "src/a.ts", path: "/w/src/a.ts" }, " now");
    const out = composeMessage(Provider.CLAUDE, text, mentions);
    expect(out.message).toBe("/review please the @src/a.ts now");
    expect(out.note).toBe("[canopy] The user mentioned a path in this thread's folder:\n- /w/src/a.ts");
    expect(slices(out.text, out.mentions)).toEqual(["/review", "@src/a.ts"]);
  });

  test("Claude: a command already first is kept; one at the end leads", () => {
    const first = message({ kind: MentionKind.COMMAND, name: "compact" }, " keep the plan");
    expect(composeMessage(Provider.CLAUDE, first.text, first.mentions).text).toBe("/compact keep the plan");
    const last = message("summary ", { kind: MentionKind.COMMAND, name: "compact" });
    const out = composeMessage(Provider.CLAUDE, last.text, last.mentions);
    expect(out.text).toBe("/compact summary");
    expect(slices(out.text, out.mentions)).toEqual(["/compact"]);
    const alone = message("  ", { kind: MentionKind.COMMAND, name: "context" }, " ");
    expect(composeMessage(Provider.CLAUDE, alone.text, alone.mentions).text).toBe("/context");
  });

  test("Claude: a leading skill runs as /name, other skills get the Skill tool note", () => {
    const { text, mentions } = message({ kind: MentionKind.SKILL, name: "design" }, " a page, then ", { kind: MentionKind.SKILL, name: "componentize" });
    const out = composeMessage(Provider.CLAUDE, text, mentions);
    expect(out.message).toBe("/design a page, then $componentize");
    expect(out.note).toBe("[canopy] The user picked a skill for this message; use it with the Skill tool: componentize");
    expect(slices(out.text, out.mentions)).toEqual(["/design", "$componentize"]);
  });

  test("other notes (attachments) go first, one note block without empty lines", () => {
    const { text, mentions } = message("see ", { kind: MentionKind.THREAD, name: THREAD, label: "T" });
    const out = composeMessage(Provider.CLAUDE, text, mentions, ["[canopy] The user attached a file…:\n- /a/b.png (image/png, 1 KB)"]);
    expect(out.note.startsWith("[canopy] The user attached")).toBe(true);
    expect(out.note.includes("\n\n")).toBe(false);
    expect(slices(out.text, out.mentions)).toEqual(["#T"]);
  });

  test("no mentions, no notes: the message unchanged", () => {
    expect(composeMessage(Provider.CLAUDE, "hi", [])).toEqual({ text: "hi", note: "", message: "hi", mentions: [] });
  });
});

describe("serialization", () => {
  test("mentions survive the wire in UserInput and SendMessage", () => {
    const { text, mentions } = message("ż ", { kind: MentionKind.FILE, name: "ą/ę.md", path: "/w/ą/ę.md" }, " 👍 ", { kind: MentionKind.PLUGIN, name: "apple-music", label: "Apple Music", path: "app://apple-music", source: "plugin" });
    const input = fromBinary(UserInputSchema, toBinary(UserInputSchema, create(UserInputSchema, { text, mentions })));
    expect(slices(input.text, input.mentions)).toEqual(["@ą/ę.md", "$apple-music"]);
    expect(input.mentions[1]).toMatchObject({ kind: MentionKind.PLUGIN, label: "Apple Music", path: "app://apple-music", source: "plugin" });
    const request = fromBinary(ui.SendMessageRequestSchema, toBinary(ui.SendMessageRequestSchema, create(ui.SendMessageRequestSchema, { threadId: THREAD, text, mentions })));
    expect(checkMentions(request.text, request.mentions)).toHaveLength(2);
  });
});

describe("fuzzy", () => {
  test("subsequence, case-insensitive, with indices", () => {
    expect(fuzzyMatch("hst", "apps/worker/src/runtime/host.ts")?.indices).toEqual([24, 26, 27]);
    expect(fuzzyMatch("xyz", "host.ts")).toBeUndefined();
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  test("file names and word starts rank first", () => {
    const paths = ["packages/codex-protocol/src/gen/v2/HookRunStatus.ts", "tests/integration/worker-host.test.ts", "apps/worker/src/runtime/host.ts", "docs/hosting.md"];
    const ranked = fuzzyRank("host.ts", paths, (p) => [p]).map((r) => r.item);
    expect(ranked[0]).toBe("apps/worker/src/runtime/host.ts");
    expect(ranked).not.toContain("docs/hosting.md");
    expect(fuzzyRank("tdev", ["design", "transitions-dev", "transitions-polish"], (s) => [s])[0]?.item).toBe("transitions-dev");
  });

  test("ties keep the given order (newest first) and the limit holds", () => {
    const ranked = fuzzyRank("plan", ["Plan B", "Plan A", "other"], (s) => [s], 1);
    expect(ranked.map((r) => r.item)).toEqual(["Plan B"]);
  });
});
