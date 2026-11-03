import { parseObject, str } from "#lib/shared/format.ts";
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

export function parseQuestions(requestJson: string): Question[] {
  const outer = parseObject(requestJson);
  const request = outer["input"] && typeof outer["input"] === "object" ? outer["input"] as Record<string, unknown> : outer;
  const list = Array.isArray(request["questions"]) ? (request["questions"] as unknown[]) : [];
  const questions = list.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const q = value as Record<string, unknown>;
    const options = Array.isArray(q["options"])
      ? (q["options"] as unknown[]).flatMap((o) => (o && typeof o === "object" ? [{ label: str((o as Record<string, unknown>)["label"]), description: str((o as Record<string, unknown>)["description"]) }] : []))
      : [];
    return [{ id: str(q["id"]) || `q${index}`, header: str(q["header"]), question: str(q["question"]), options: options.filter((o) => o.label),
      kind: q["kind"] === "multiple_choice" || q["multiSelect"] === true ? "multiple_choice" as const : options.length === 0 ? "text" as const : "single_choice" as const,
      recommended: str(q["recommended"]) || options.find((o) => /\(Recommended\)$/i.test(o.label))?.label || "",
      other: true, secret: q["isSecret"] === true }];
  });
  // A bare prompt without structured questions still gets one free-text field.
  return questions.length > 0 ? questions : [{ id: "answer", header: "", question: str(request["question"]) || str(request["message"]), options: [], kind: "text", recommended: "", other: true, secret: false }];
}

/** Answers keyed by question id, as the worker forwards them to Codex (`answers: { id: { answers: [...] } }`). */
export const answersJson = (answers: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()).map(([id, v]) => [id, { answers: [v.trim()] }])));

/** Typed text wins over selections. Empty is never silently submitted as a skip. */
export function currentAnswer(question: Question, labels: readonly string[], text: string): UserAnswer | undefined {
  if (text.trim()) return { id: question.id, kind: "text", text: text.trim() };
  if (labels.length) return { id: question.id, kind: "choice", labels: [...labels] };
  return undefined;
}

/** Native harnesses keep their wire shapes; the platform always gets the discriminated answer contract. */
export function encodeAnswers(tool: string, questions: readonly Question[], answers: readonly UserAnswer[]): string {
  if (tool === "ask_user") return JSON.stringify({ answers });
  const values = (a: UserAnswer): string[] => a.kind === "text" ? [a.text] : a.kind === "choice" ? [...a.labels] : [];
  if (tool === "AskUserQuestion") return JSON.stringify(Object.fromEntries(questions.map((q) => [q.question, values(answers.find((a) => a.id === q.id)!).join(", ")])));
  return JSON.stringify(Object.fromEntries(answers.map((a) => [a.id, { answers: values(a) }])));
}

export function answerText(responseJson: string, question: Question): string {
  const response = parseObject(responseJson);
  if (Array.isArray(response["answers"])) {
    const answer = (response["answers"] as UserAnswer[]).find((a) => a.id === question.id);
    return !answer ? "" : answer.kind === "skipped" ? "Skipped" : answer.kind === "text" ? answer.text : answer.labels.join(", ");
  }
  const map = response["answers"] && typeof response["answers"] === "object" ? response["answers"] as Record<string, unknown> : response;
  const value = map[question.id] ?? map[question.question];
  if (typeof value === "string") return value || "Skipped";
  const labels = value && typeof value === "object" ? (value as { answers?: unknown }).answers : value;
  return Array.isArray(labels) ? labels.filter((s) => typeof s === "string").join(", ") || "Skipped" : "";
}
