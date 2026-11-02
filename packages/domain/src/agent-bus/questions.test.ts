import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { agentBusToolSpecs, agentBusToolsFor, decodeAgentBusCall } from "./tools.ts";
import { decodeUserAnswers, questionAnswerInput, questionResult, type UserQuestion } from "./questions.ts";

const question: UserQuestion = { id: "auth", header: "Auth method", question: "Which authentication method?", kind: "single_choice", options: [{ label: "OAuth" }, { label: "Password", description: "Local accounts" }], recommended: "OAuth" };
describe("platform question contract", () => {
  test("both harnesses and side threads share the schema, with bounded questions and options", () => {
    expect(agentBusToolsFor(1)).toEqual(expect.arrayContaining(["ask_user", "get_answers"]));
    const spec = agentBusToolSpecs().find((s) => s.name === "ask_user")!;
    expect(spec.inputSchema).toMatchObject({ properties: { questions: { minItems: 1, maxItems: 4 }, wait: { type: "boolean" } }, required: ["questions", "wait"] });
    expect(Result.isSuccess(decodeAgentBusCall("ask_user", JSON.stringify({ questions: [question], wait: false })))).toBe(true);
    for (const args of [
      { questions: [], wait: true }, { questions: [question] }, { questions: [question], wait: true, extra: true },
      { questions: [question, question], wait: true }, { questions: [{ ...question, recommended: "missing" }], wait: true },
      { questions: [{ ...question, options: [] }], wait: true }, { questions: [{ ...question, kind: "text" }], wait: true },
    ]) expect(Result.isFailure(decodeAgentBusCall("ask_user", JSON.stringify(args)))).toBe(true);
  });
  test("validates choice, custom text, multiple choice and explicit skips in question order", () => {
    const questions: UserQuestion[] = [question, { ...question, id: "scope", kind: "multiple_choice" }, { id: "note", header: "Note", question: "Anything else?", kind: "text" }];
    const answers = [{ id: "note", kind: "skipped" }, { id: "scope", kind: "choice", labels: ["OAuth", "Password"] }, { id: "auth", kind: "text", text: "Use a passkey" }];
    const decoded = decodeUserAnswers(JSON.stringify({ answers }), questions);
    expect(Result.isSuccess(decoded) ? decoded.success.map((a) => a.id) : []).toEqual(["auth", "scope", "note"]);
    for (const invalid of [[], [answers[0], answers[0], answers[0]], [{ id: "auth", kind: "choice", labels: ["missing"] }], [{ id: "auth", kind: "choice", labels: ["OAuth", "Password"] }], [{ id: "auth", kind: "text", text: " " }]]) {
      expect(Result.isFailure(decodeUserAnswers(JSON.stringify({ answers: invalid }), [question]))).toBe(true);
    }
  });
  test("agent results distinguish pending, skipped and dismissed without inventing an answer", () => {
    expect(questionResult("set", "pending", null)).toMatchObject({ status: "pending", answers: [], next: expect.stringContaining("Still waiting") });
    const response = { answerJson: JSON.stringify({ answers: [{ id: "auth", kind: "skipped" }] }) };
    expect(questionResult("set", "answered", response)).toEqual({ question_set_id: "set", status: "answered", answers: [{ id: "auth", kind: "skipped" }] });
    expect(questionResult("set", "cancelled", null)).toEqual({ question_set_id: "set", status: "dismissed", answers: [] });
  });
  test("answer delivery keeps structured data for the agent and readable text for the timeline", () => {
    const input = questionAnswerInput("set", "answered", { answerJson: JSON.stringify({ answers: [{ id: "auth", kind: "choice", labels: ["OAuth"] }] }) }, [question]);
    expect(input.message).toBe("Auth method: OAuth");
    expect(input.note).toContain('"labels":["OAuth"]');
    expect(input.text).toBe(`${input.note}\n\n${input.message}`);
    expect(questionAnswerInput("set", "cancelled", null, [question]).message).toBe("Questions dismissed.");
  });
});
