import { parseObject, str } from "#lib/shared/format.ts";

/** A question in a QUESTION interaction (Codex request_user_input shape; Claude maps onto it). */
export interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { label: string; description: string }[];
  /** Free text is allowed (besides or instead of the options). */
  readonly other: boolean;
  readonly secret: boolean;
}

export function parseQuestions(requestJson: string): Question[] {
  const request = parseObject(requestJson);
  const list = Array.isArray(request["questions"]) ? (request["questions"] as unknown[]) : [];
  const questions = list.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const q = value as Record<string, unknown>;
    const options = Array.isArray(q["options"])
      ? (q["options"] as unknown[]).flatMap((o) => (o && typeof o === "object" ? [{ label: str((o as Record<string, unknown>)["label"]), description: str((o as Record<string, unknown>)["description"]) }] : []))
      : [];
    return [{ id: str(q["id"]) || `q${index}`, header: str(q["header"]), question: str(q["question"]), options: options.filter((o) => o.label), other: q["isOther"] === true || options.length === 0, secret: q["isSecret"] === true }];
  });
  // A bare prompt without structured questions still gets one free-text field.
  return questions.length > 0 ? questions : [{ id: "answer", header: "", question: str(request["question"]) || str(request["message"]), options: [], other: true, secret: false }];
}

/** Answers keyed by question id, as the worker forwards them to Codex (`answers: { id: { answers: [...] } }`). */
export const answersJson = (answers: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()).map(([id, v]) => [id, { answers: [v.trim()] }])));
