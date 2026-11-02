import { describe, expect, test } from "bun:test";
import { answerText, currentAnswer, encodeAnswers, parseQuestions } from "./questions.ts";

describe("question UI / harness answer adapters", () => {
  test("platform, Claude wrapped input and Codex questions share the same presentation", () => {
    const native = { questions: [{ question: "Which?", header: "Method", multiSelect: true, options: [{ label: "A", description: "First" }, { label: "B" }] }] };
    const claude = parseQuestions(JSON.stringify({ input: native }));
    expect(claude[0]).toMatchObject({ id: "q0", kind: "multiple_choice", other: true, options: [{ label: "A", description: "First" }, { label: "B", description: "" }] });
    expect(parseQuestions(JSON.stringify({ questions: [{ id: "x", header: "Method", question: "Which?", options: [{ label: "A (Recommended)" }] }] }))[0]?.recommended).toBe("A (Recommended)");
  });
  test("typed answer wins over selections; blank requires an explicit skip", () => {
    const q = parseQuestions('{"questions":[{"id":"x","question":"Which?","options":[{"label":"A"}]}]}')[0]!;
    expect(currentAnswer(q, ["A"], " custom ")).toEqual({ id: "x", kind: "text", text: "custom" });
    expect(currentAnswer(q, ["A"], " ")).toEqual({ id: "x", kind: "choice", labels: ["A"] });
    expect(currentAnswer(q, [], " ")).toBeUndefined();
    const answers = [{ id: "x", kind: "skipped" as const }];
    expect(encodeAnswers("ask_user", [q], answers)).toBe('{"answers":[{"id":"x","kind":"skipped"}]}');
    expect(encodeAnswers("request_user_input", [q], answers)).toBe('{"x":{"answers":[]}}');
    expect(encodeAnswers("AskUserQuestion", [q], [{ id: "x", kind: "choice", labels: ["A"] }])).toBe('{"Which?":"A"}');
    expect(answerText(encodeAnswers("ask_user", [q], answers), q)).toBe("Skipped");
    expect(answerText('{"Which?":"A"}', q)).toBe("A");
  });
});
