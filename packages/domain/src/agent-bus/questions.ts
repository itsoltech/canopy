import { Result, Schema } from "effect";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
export const UserQuestion = Schema.Struct({
  id: Text(64).annotate({ description: "Unique id within this question set." }),
  header: Text(32).annotate({ description: "Short topic chip, e.g. Auth method." }),
  question: Text(2000),
  kind: Schema.Literals(["single_choice", "multiple_choice", "text"]),
  options: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Text(120), description: Schema.optionalKey(Text(500)) })).check(Schema.isMaxLength(9))),
  recommended: Schema.optionalKey(Text(120).annotate({ description: "Label of the recommended option, if any. Never selects it on the user's behalf." })),
});
export type UserQuestion = Schema.Schema.Type<typeof UserQuestion>;
export const AskUser = Schema.Struct({
  questions: Schema.Array(UserQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  wait: Schema.Boolean.annotate({ description: "true: wait for answers before continuing; false: keep working and receive answers as a steer or a new turn." }),
});
export const GetAnswers = Schema.Struct({
  question_set_id: Schema.String.check(Schema.isUUID()),
  wait: Schema.optionalKey(Schema.Boolean.annotate({ description: "true: wait up to 120 seconds; repeat while pending. false (default): check immediately." })),
});

export const QUESTION_TOOLS = {
  ask_user: {
    name: "ask_user",
    description: "Ask the user 1–4 questions. Use wait=true when the answer blocks your task; do not continue until answered or dismissed. " +
      "A wait is bounded to 120 seconds: if still pending, call get_answers with wait=true again, without doing other work. " +
      "Use wait=false for optional clarification while you keep working; answers arrive as a steer into your running turn, or a new turn afterwards. " +
      "Use short option labels, optional descriptions and recommended to mark your recommendation. The user may type their own answer or skip any/all questions. " +
      "Questions survive restarts. Side-thread questions follow the thread's interaction route (parent or human).",
    args: AskUser, mutates: true,
  },
  get_answers: {
    name: "get_answers",
    description: "Read your question set's pending/answered/dismissed state and structured answers. For a pending synchronous question, use wait=true repeatedly until answered; do not continue the task meanwhile. Does not ask the questions again.",
    args: GetAnswers, mutates: false,
  },
} as const;

/** Semantic constraints that JSON Schema cannot express without provider-specific extensions. */
export function questionsProblem(questions: readonly UserQuestion[]): string | undefined {
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return "question ids must be unique";
  for (const q of questions) {
    const labels = (q.options ?? []).map((o) => o.label);
    if (q.kind !== "text" && labels.length < 1) return `${q.id}: choice questions need options`;
    if (q.kind === "text" && (labels.length || q.recommended)) return `${q.id}: text questions cannot have options or a recommendation`;
    if (new Set(labels).size !== labels.length) return `${q.id}: option labels must be unique`;
    if (q.recommended && !labels.includes(q.recommended)) return `${q.id}: recommended must name an option label`;
    if (![q.id, q.header, q.question, ...labels].every((s) => s.trim())) return "question text and labels cannot be blank";
  }
  return undefined;
}

const Answer = Schema.Union([
  Schema.Struct({ id: Text(64), kind: Schema.Literal("choice"), labels: Schema.Array(Text(120)).check(Schema.isMinLength(1), Schema.isMaxLength(9)) }),
  Schema.Struct({ id: Text(64), kind: Schema.Literal("text"), text: Text(20_000) }),
  Schema.Struct({ id: Text(64), kind: Schema.Literal("skipped") }),
]);
export type UserAnswer = Schema.Schema.Type<typeof Answer>;

export function decodeUserAnswers(json: string, questions: readonly UserQuestion[]): Result.Result<readonly UserAnswer[], string> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return Result.fail("answers must be valid JSON"); }
  const decoded = Schema.decodeUnknownResult(Schema.Struct({ answers: Schema.Array(Answer) }))(value, { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message);
  const { answers } = decoded.success;
  if (answers.length !== questions.length || new Set(answers.map((a) => a.id)).size !== questions.length) return Result.fail("answer or explicitly skip every question, once each");
  for (const answer of answers) {
    const question = questions.find((q) => q.id === answer.id);
    if (!question) return Result.fail(`unknown question ${answer.id}`);
    if (answer.kind === "text" && !answer.text.trim()) return Result.fail("text answers cannot be blank");
    if (answer.kind === "choice") {
      if (question.kind === "text" || (question.kind === "single_choice" && answer.labels.length !== 1) || new Set(answer.labels).size !== answer.labels.length || answer.labels.some((l) => !question.options?.some((o) => o.label === l))) return Result.fail(`${answer.id}: invalid choice`);
    }
  }
  return Result.succeed(questions.map((q) => answers.find((a) => a.id === q.id)!));
}

export function questionResult(id: string, status: string, response: { answerJson?: string } | null) {
  return {
    question_set_id: id,
    status: status === "pending" ? "pending" : status === "cancelled" ? "dismissed" : "answered",
    answers: status === "answered" && response?.answerJson ? (JSON.parse(response.answerJson) as { answers: UserAnswer[] }).answers.map((answer) =>
      answer.kind === "choice" ? { ...answer, labels: [...answer.labels] } : { ...answer }) : [],
    ...(status === "pending" && { next: "Still waiting. For synchronous questions call get_answers with wait=true; do not continue until answered or dismissed." }),
  };
}

/** Structured data for the model, readable answers for the timeline's turn/steer bubble. */
export function questionAnswerInput(id: string, status: string, response: { answerJson?: string } | null, questions: readonly UserQuestion[]) {
  const result = questionResult(id, status, response);
  const message = result.status === "dismissed" ? "Questions dismissed." : result.answers.map((answer) => {
    const header = questions.find((q) => q.id === answer.id)?.header ?? answer.id;
    const value = answer.kind === "choice" ? answer.labels.join(", ") : answer.kind === "text" ? answer.text : "Skipped";
    return `${header}: ${value}`;
  }).join("\n");
  const note = `[open-agents] Answers to your questions (question_set_id: ${id}).\n${JSON.stringify(result)}`;
  return { text: `${note}\n\n${message}`, note, message };
}
