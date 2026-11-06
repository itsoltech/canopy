import { Text, View } from "react-native";
import { InteractionKind, type InteractionPrompt, type ItemStatus } from "@canopy/contracts";
import { prettyJson } from "@canopy/domain/format";
import { humanizeToolName } from "@canopy/domain/humanize";
import { answerText, parseQuestions } from "@canopy/domain/questions";
import { statusLook } from "@canopy/domain/status-look";
import { Badge } from "../../../ui/Badge";
import { RequestCountdown } from "../../../ui/RequestCountdown";
import { font, styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { CodeBlock } from "../CodeBlock";
import { ItemFrame } from "../ItemFrame";
import { useTimelineDirectory } from "../directory";
import { RawToggle } from "./parts";

const SUBJECTS = new Map([
  ["shell", "Run a command"],
  ["apply_patch", "Apply a change"],
  ["permissions", "Extra permissions"],
]);

/** Record of a permission request or question: what was asked, the answer and who gave it (web: InteractionPromptView). */
export function InteractionPromptView({ prompt, status }: { prompt: InteractionPrompt; status: ItemStatus }) {
  const c = useColors();
  const violet = useTone("violet").text;
  const directory = useTimelineDirectory();
  const permission = prompt.kind === InteractionKind.PERMISSION;
  const kind = permission ? "Permission" : prompt.kind === InteractionKind.QUESTION ? "Question" : "Form";
  const subject = permission ? (SUBJECTS.get(prompt.toolName) ?? humanizeToolName(prompt.toolName)) : "";
  const questions = prompt.kind === InteractionKind.QUESTION ? parseQuestions(prompt.requestJson) : [];
  const answers = Object.fromEntries(questions.map((q) => [q.id, answerText(prompt.responseJson, q)]));
  const secret = questions.some((q) => q.secret);
  const first = questions[0];

  const said = (id: string, isSecret: boolean) =>
    answers[id] ? (isSecret ? "Answered (hidden)" : answers[id]) : prompt.outcome === "cancelled" ? "Dismissed" : "";

  const preview = first
    ? [first.header || first.question, said(first.id, first.secret) && `→ ${said(first.id, first.secret)}`]
        .filter(Boolean)
        .join(" ") + (questions.length > 1 ? ` · +${questions.length - 1}` : "")
    : "";

  const by = prompt.answeredByThreadId
    ? `answered by ${directory.thread(prompt.answeredByThreadId)?.title || "the parent agent"}`
    : prompt.answeredByUserId
      ? "answered by you"
      : prompt.routedTo === "parent" && !prompt.outcome
        ? "for the parent agent"
        : "";

  const look = statusLook(prompt.outcome || "pending");

  return (
    <ItemFrame
      icon={permission ? "shield-check" : "question-mark-circle"}
      status={status}
      label={[kind, subject || preview, by].filter(Boolean).join(" ")}
      title={
        <Text numberOfLines={1} style={[styles.work, { color: c.soft }]}>
          {kind}
          {preview ? <Text style={{ color: c.muted }}>{`  ${preview}`}</Text> : null}
          {subject ? <Text style={{ color: c.strong }}>{`  ${subject}`}</Text> : null}
          {by ? <Text style={{ color: by === "for the parent agent" ? violet : c.muted }}>{`  ${by}`}</Text> : null}
        </Text>
      }
      aside={
        <Badge tone={look.tone} dot>
          {look.label}
        </Badge>
      }
    >
      {prompt.expiresAt && <RequestCountdown expiresAt={prompt.expiresAt} pending={!prompt.outcome} />}
      {questions.length > 0 ? (
        <View style={{ gap: 8 }}>
          {questions.map((question) => (
            <View key={question.id} style={{ gap: 2 }}>
              <Text style={[styles.work, { fontFamily: font.medium, color: c.text }]}>
                {question.question || question.header || "Question"}
              </Text>
              {said(question.id, question.secret) ? (
                <Text style={[styles.work, { color: c.muted }]}>{said(question.id, question.secret)}</Text>
              ) : question.options.length > 0 ? (
                <Text style={[styles.work, { color: c.muted, fontStyle: "italic" }]}>
                  Options: {question.options.map((o) => o.label).join(", ")}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : (
        <CodeBlock text={prettyJson(prompt.requestJson)} label="Request" />
      )}
      <RawToggle
        parts={[
          { label: "Request", text: prompt.requestJson },
          { label: "Response", text: secret ? "" : prompt.responseJson },
        ]}
      />
    </ItemFrame>
  );
}
