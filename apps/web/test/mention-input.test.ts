import { describe, expect, test } from "bun:test";
import { activeTrigger, type ActiveTrigger, type TriggerChar } from "../src/lib/features/mentions/editor.ts";
import { InputSession } from "../src/lib/features/mentions/input-session.ts";

const triggers = new Set<TriggerChar>(["/", "$", "@", "#"]);

/** The event adapter used by MentionEditor: each read queries the current text before
 * the caret; formatting is separately gated so composition never rewrites the IME DOM.
 */
function editor() {
  let text = "";
  const reads: { trigger: ActiveTrigger | undefined; format: boolean }[] = [];
  const session = new InputSession((format) => reads.push({ trigger: activeTrigger(text, triggers), format }));
  return { session, reads, text: (value: string) => { text = value; } };
}

describe("native mention input sequences", () => {
  for (const char of triggers) test(`${char}: iOS composition input queries before compositionend, then formats the commit`, () => {
    const e = editor();
    e.session.start();
    e.text(char);
    e.session.input({ inputType: "insertCompositionText", isComposing: true });
    expect(e.reads.at(-1)).toEqual({ trigger: { char, query: "", length: 1 }, format: false });
    e.text(`${char}żółć`);
    e.session.input({ inputType: "insertCompositionText", isComposing: true });
    expect(e.reads.at(-1)?.trigger?.query).toBe("żółć");
    // Safari may not send a final input after compositionend.
    e.session.end();
    expect(e.session.composing).toBe(false);
    expect(e.reads.at(-1)).toEqual({ trigger: { char, query: "żółć", length: 5 }, format: true });
  });

  test.each(["insertReplacementText", "insertText", "insertCompositionText"])("%s recovers a missing compositionend", (inputType) => {
    const e = editor();
    e.session.start();
    e.text("$design");
    e.session.input({ inputType, isComposing: false });
    expect(e.session.composing).toBe(false);
    expect(e.reads.at(-1)).toEqual({ trigger: { char: "$", query: "design", length: 7 }, format: true });
  });

  test("replacement, deletion and undo query the latest text without stale triggers", () => {
    const e = editor();
    e.text("/review"); e.session.input({ inputType: "insertReplacementText", isComposing: false });
    expect(e.reads.at(-1)?.trigger?.char).toBe("/");
    e.text("review"); e.session.input({ inputType: "deleteContentBackward", isComposing: false });
    expect(e.reads.at(-1)?.trigger).toBeUndefined();
    e.text("@src"); e.session.input({ inputType: "historyUndo", isComposing: false });
    expect(e.reads.at(-1)).toEqual({ trigger: { char: "@", query: "src", length: 4 }, format: false });
  });

  test("blur/focus resets a cancelled composition; an ordinary input remains usable", () => {
    const e = editor();
    e.session.start(); e.session.reset();
    expect(e.session.composing).toBe(false);
    e.text("#Plan"); e.session.input({ inputType: "insertText", isComposing: false });
    expect(e.reads.at(-1)).toEqual({ trigger: { char: "#", query: "Plan", length: 5 }, format: true });
  });
});
