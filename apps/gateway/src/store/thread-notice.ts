import type { JsonValue } from "@bufbuild/protobuf";
import { Predicate } from "effect";
import { isJsonArray, isJsonObject, noticePreview, safeFailureDetail } from "@canopy/domain";
import type { NoticeInteractionColumns, ThreadRow } from "./rows.ts";

const text = (value: JsonValue | undefined) => (Predicate.isString(value) ? value : "");

/** What a pending request asks, in the request shapes the interaction cards read (questions.ts, PermissionRequest). */
function asked(interaction: NoticeInteractionColumns): string {
  const outer = isJsonObject(interaction.request) ? interaction.request : {};
  const input = outer["input"];
  const request = isJsonObject(input) ? input : outer;

  if (interaction.kind === "permission")
    return text(request["reason"]) || text(request["description"]) || text(request["command"]) || interaction.tool;
  const questions = request["questions"];
  const first = isJsonArray(questions) ? questions[0] : undefined;

  return (isJsonObject(first) ? text(first["question"]) : "") || text(request["question"]) || text(request["message"]);
}

/**
 * The thread's notification fields (ui.Thread 1000+): only threads with something to notify about carry a preview,
 * so the overview stays small. Previews are plain text without markdown or credentials (noticePreview).
 */
export function threadNotice(row: ThreadRow) {
  const interaction = Number(row.pending_interactions ?? 0) > 0 ? row.notice_interaction : undefined;
  const turn = row.unseen_turn;

  const preview = interaction
    ? asked(interaction)
    : turn?.message || (turn?.status === "failed" && turn.error ? safeFailureDetail(turn.error) : "");

  return {
    unseenResult: turn?.status ?? "",
    noticePreview: noticePreview(preview),
    noticeInteractionKind: interaction?.kind ?? "",
    interruptedByUser: turn?.status === "interrupted" && turn.interrupt_source === "user",
  };
}
