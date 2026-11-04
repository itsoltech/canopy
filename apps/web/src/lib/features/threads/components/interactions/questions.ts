import { isJsonArray, isJsonObject, isString, listOf, objectsOf, parseObject, str } from "#lib/shared/json.ts";
import type { UserAnswer } from "@canopy/domain";

/** A question in a QUESTION interaction (Codex request_user_input shape; Claude maps onto it). */
export interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { label: string; description: string }[];
  readonly kind: "single_choice" | "multiple_choice" | "text";
  readonly recommended: string;
  /** Free text is allowed (besides or instead of the options). */
  readonly other: boolean;
  readonly secret: boolean;
}

function questionKind(multiple: boolean, options: number): Question["kind"] {
  if (multiple) return "multiple_choice";

  return options === 0 ? "text" : "single_choice";
}

export function parseQuestions(requestJson: string): Question[] {
  const outer = parseObject(requestJson);

  const input = outer["input"];
  const request = isJsonObject(input) ? input : outer;

  const questions = objectsOf(request["questions"]).map((q, index): Question => {
    const options = objectsOf(q["options"]).map((o) => ({
      label: str(o["label"]),
      description: str(o["description"]),
    }));

    return {
      id: str(q["id"]) || `q${index}`,
      header: str(q["header"]),
      question: str(q["question"]),
      options: options.filter((o) => o.label),
      kind: questionKind(q["kind"] === "multiple_choice" || q["multiSelect"] === true, options.length),
      recommended: str(q["recommended"]) || options.find((o) => /\(Recommended\)$/i.test(o.label))?.label || "",
      other: true,
      secret: q["isSecret"] === true,
    };
  });

  // A bare prompt without structured questions still gets one free-text field.
  return questions.length > 0
    ? questions
    : [
        {
          id: "answer",
          header: "",
          question: str(request["question"]) || str(request["message"]),
          options: [],
          kind: "text",
          recommended: "",
          other: true,
          secret: false,
        },
      ];
}

/** Answers keyed by question id, as the worker forwards them to Codex (`answers: { id: { answers: [...] } }`). */
export const answersJson = (answers: Record<string, string>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(answers)
        .filter(([, v]) => v.trim())
        .map(([id, v]) => [id, { answers: [v.trim()] }]),
    ),
  );

/** Typed text wins over selections. Empty is never silently submitted as a skip. */
export function currentAnswer(question: Question, labels: readonly string[], text: string): UserAnswer | undefined {
  if (text.trim()) return { id: question.id, kind: "text", text: text.trim() };

  if (labels.length) return { id: question.id, kind: "choice", labels: [...labels] };

  return undefined;
}

function answerValues(answer: UserAnswer | undefined): string[] {
  switch (answer?.kind) {
    case "text":
      return [answer.text];
    case "choice":
      return [...answer.labels];
    default:
      return [];
  }
}

/** Native harnesses keep their wire shapes; the platform always gets the discriminated answer contract. */
export function encodeAnswers(tool: string, questions: readonly Question[], answers: readonly UserAnswer[]): string {
  if (tool === "ask_user") return JSON.stringify({ answers });

  if (tool === "AskUserQuestion")
    return JSON.stringify(
      Object.fromEntries(
        questions.map((q) => [q.question, answerValues(answers.find((a) => a.id === q.id)).join(", ")]),
      ),
    );

  return JSON.stringify(Object.fromEntries(answers.map((a) => [a.id, { answers: answerValues(a) }])));
}

export function answerText(responseJson: string, question: Question): string {
  const response = parseObject(responseJson);

  const answers = response["answers"];

  // The platform's answer contract: `{answers: [{id, kind, …}]}`.
  if (isJsonArray(answers)) {
    const answer = objectsOf(answers).find((a) => a["id"] === question.id);

    if (!answer) return "";

    switch (answer["kind"]) {
      case "skipped":
        return "Skipped";
      case "text":
        return str(answer["text"]);
      default:
        return listOf(answer["labels"]).filter(isString).join(", ");
    }
  }

  // Native shapes: `{answers: {id: {answers: [...]}}}`, or answers keyed by question text.
  const map = isJsonObject(answers) ? answers : response;
  const value = map[question.id] ?? map[question.question];

  if (isString(value)) return value || "Skipped";
  const labels = isJsonObject(value) ? value["answers"] : undefined;

  return isJsonArray(labels) ? labels.filter(isString).join(", ") || "Skipped" : "";
}
