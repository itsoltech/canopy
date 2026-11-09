import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Field, Notice } from "../../../ui/components";
import { Swap } from "../../../ui/MotionViews";
import { RequestHeader } from "../../../ui/RequestHeader";
import { font, styles, useColors } from "../../../ui/theme";
import { QuestionOption } from "./QuestionOption";
import { QuestionActions } from "./QuestionActions";
import { useQuestionDraft } from "./useQuestionDraft";

export function QuestionForm({
  interaction,
  draft,
}: {
  interaction: ui.Interaction;
  draft: ReturnType<typeof useQuestionDraft>;
}) {
  const c = useColors();
  const q = draft.question;

  if (!q) return <Notice>This request is no longer pending. Check the thread for details.</Notice>;

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.overlayMeta, { color: c.muted }]}>
        {interaction.asynchronous
          ? "The agent keeps working. Answer any time."
          : "The agent is waiting for your answers."}
      </Text>
      {interaction.routedTo === "parent" && (
        <Text style={[styles.overlayMeta, { color: c.muted }]}>The parent agent can answer. You can step in.</Text>
      )}
      <RequestHeader expiresAt={interaction.expiresAt} pending={!draft.done && interaction.status === "pending"}>
        <Text accessibilityRole="header" style={[styles.overlay, { color: c.text, fontFamily: font.medium }]}>
          {draft.questions.length > 1 ? `${draft.step + 1} of ${draft.questions.length} · ` : ""}
          {q.header || "Question"}
        </Text>
      </RequestHeader>
      <Swap value={q.id}>
        <View style={{ gap: 8 }}>
          <Text selectable style={[styles.overlay, { color: c.text }]}>
            {q.question}
          </Text>
          {q.options.length > 0 && (
            <Text style={[styles.overlayMeta, { color: c.muted }]}>
              {q.kind === "multiple_choice" ? "Choose any" : "Choose one"}
            </Text>
          )}
          <View accessibilityRole={q.kind === "single_choice" ? "radiogroup" : undefined}>
            {q.options.map((option) => (
              <QuestionOption
                key={option.label}
                option={option}
                multiple={q.kind === "multiple_choice"}
                checked={draft.labels.includes(option.label)}
                recommended={q.recommended === option.label}
                disabled={draft.disabled}
                onSelect={() => draft.select(option.label)}
              />
            ))}
          </View>
          {q.other && (
            <Field
              key={q.id}
              label={q.options.length ? "Or type your own answer" : "Your answer"}
              value={draft.text}
              onChangeText={draft.setText}
              editable={!draft.disabled}
              secureTextEntry={q.secret}
              autoCorrect={!q.secret}
              autoComplete="off"
              multiline={!q.secret}
              numberOfLines={2}
              placeholder="Type your answer…"
              style={{ textAlignVertical: "top" }}
            />
          )}
        </View>
      </Swap>
      {draft.error ? <Notice error>{draft.error}</Notice> : null}
      {!draft.online && <Notice>Reconnect to send your answers. Your draft stays here.</Notice>}
      <QuestionActions draft={draft} asynchronous={interaction.asynchronous} />
    </View>
  );
}
