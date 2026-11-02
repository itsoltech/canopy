import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { PermissionMode, ui } from "@open-agents/contracts";
import { MentionKind, MentionSchema } from "@open-agents/contracts";
import { moveTo, ordered, overrides, queuedText, relocateMentions, steerable } from "./queue.ts";

const turn = (id: string, extra: MessageInitShape<typeof ui.TurnSchema> = {}) => create(ui.TurnSchema, { id, status: "queued", trigger: "user", ...extra });

describe("queue panel", () => {
  test("moveTo puts a row at an index, clamped; an unknown id changes nothing", () => {
    expect(moveTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveTo(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
    expect(moveTo(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveTo(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });

  test("ordered: the local order first, turns queued meanwhile after it, gone ones dropped", () => {
    const turns = [turn("a"), turn("b"), turn("d")];
    expect(ordered(turns, undefined).map((t) => t.id)).toEqual(["a", "b", "d"]);
    expect(ordered(turns, ["b", "c", "a"]).map((t) => t.id)).toEqual(["b", "a", "d"]);
  });

  test("overrides name what the message runs with; text without the platform note on one line", () => {
    const files = [create(ui.AttachmentSchema, { id: "f1" }), create(ui.AttachmentSchema, { id: "f2" })];
    const queued = turn("a", { model: "gpt-5.5", effort: "high", permissionMode: PermissionMode.READ_ONLY, attachments: files, inputText: "[note]\n\nfix it", messageText: "fix\n it" });
    expect(overrides(queued)).toEqual(["GPT-5.5", "High effort", "Read only", "2 files"]);
    expect(overrides(turn("b"))).toEqual([]);
    expect(queuedText(queued)).toBe("fix it");
    expect([steerable(queued), steerable(turn("c")), steerable(turn("d", { trigger: "agent_bus" }))]).toEqual([false, true, false]);
  });

  test("relocateMentions keeps the chips the edited text still has, at their new places", () => {
    const before = "use $review on @src/a.ts now";
    const mentions = [
      create(MentionSchema, { kind: MentionKind.FILE, name: "src/a.ts", start: 15, end: 24 }),
      create(MentionSchema, { kind: MentionKind.SKILL, name: "review", start: 4, end: 11 }),
    ];
    const after = "please use $review on @src/a.ts";
    expect(relocateMentions(before, mentions, after).map((m) => [m.name, after.slice(m.start, m.end)])).toEqual([
      ["review", "$review"],
      ["src/a.ts", "@src/a.ts"],
    ]);
    expect(relocateMentions(before, mentions, "use $review now").map((m) => m.name)).toEqual(["review"]);
  });
});
