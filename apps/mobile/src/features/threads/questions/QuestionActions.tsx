import { Text, View } from "react-native";
import { Button, Notice } from "../../../ui/components";
import { styles, useColors } from "../../../ui/theme";
import type { useQuestionDraft } from "./useQuestionDraft";

export function QuestionActions({
  draft,
  asynchronous,
}: {
  draft: ReturnType<typeof useQuestionDraft>;
  asynchronous: boolean;
}) {
  const c = useColors();

  if (draft.done)
    return (
      <Notice>
        {draft.dismissed
          ? "Request dismissed. Check the thread for details."
          : "Answers sent. Check the thread for the answers."}
      </Notice>
    );

  return (
    <View style={{ gap: 12 }}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap", gap: 16 }]}>
        <Button
          title="Back"
          size="sm"
          variant="ghost"
          disabled={draft.disabled || draft.step === 0}
          onPress={() => draft.setStep(draft.step - 1)}
        />
        <Button
          title={draft.step + 1 < draft.questions.length ? "Submit and continue" : "Submit answer"}
          size="sm"
          variant="primary"
          disabled={draft.disabled || !draft.answer}
          busy={draft.busy}
          onPress={() => void draft.submit()}
        />
      </View>
      <View style={[styles.row, { flexWrap: "wrap", gap: 16 }]}>
        <Button
          title="Skip question"
          size="sm"
          variant="ghost"
          disabled={draft.disabled}
          onPress={() => void draft.submit(true)}
        />
        {draft.questions.length > 1 && (
          <Button
            title="Skip all"
            size="sm"
            variant="ghost"
            disabled={draft.disabled}
            onPress={() => void draft.finish(true)}
          />
        )}
        {!asynchronous && (
          <Button
            title="Dismiss request"
            size="sm"
            variant="ghost"
            disabled={draft.disabled}
            onPress={() => void draft.finish(false, true)}
          />
        )}
      </View>
      <Text style={[styles.overlayMeta, { color: c.muted }]}>Skip leaves the question unanswered.</Text>
    </View>
  );
}
