import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { InteractionKind, type ui } from "@canopy/contracts";
import { Button, Sheet } from "../../../ui/components";
import { Icon } from "../../../ui/Icon";
import { styles, useColors } from "../../../ui/theme";
import { useSession } from "../../../state/session";
import { useStream } from "../../../state/stream";
import { InteractionCard } from "../InteractionCard";
import { QuestionForm } from "./QuestionForm";
import { useQuestionDraft } from "./useQuestionDraft";

/** Only requests are retained from each child's stream; history stays in that child's own timeline. */
function ChildQuestions({
  thread,
  onChange,
}: {
  thread: ui.Thread;
  onChange: (id: string, requests: ui.Interaction[]) => void;
}) {
  const { client } = useSession();
  const [requests, setRequests] = useState<ui.Interaction[]>([]);
  useStream(
    client ? (signal) => client.api.watchThread({ threadId: thread.id, pageSize: 1 }, { signal }) : null,
    (update: ui.ThreadUpdate) => {
      if (update.change.case === "snapshot") setRequests(update.change.value.interactions);

      if (update.change.case === "interaction") {
        const request = update.change.value;
        setRequests((previous) => [...previous.filter((q) => q.requestId !== request.requestId), request]);
      }
    },
    thread.id,
  );
  useEffect(() => {
    onChange(thread.id, requests);
  }, [thread.id, requests, onChange]);
  useEffect(() => () => onChange(thread.id, []), [thread.id, onChange]);

  return null;
}

function QuestionEditor({
  interaction,
  visible,
  onClose,
  navigation,
  label,
  draft,
}: {
  interaction: ui.Interaction;
  visible: boolean;
  onClose: () => void;
  navigation: React.ReactNode;
  label?: string;
  draft: ReturnType<typeof useQuestionDraft>;
}) {
  const c = useColors();

  return (
    <Sheet
      title={interaction.kind === InteractionKind.QUESTION ? "Answer questions" : "Review request"}
      visible={visible}
      onClose={onClose}
    >
      {navigation}
      {label && <Text style={[styles.overlay, { color: c.muted }]}>Subagent: {label}</Text>}
      {interaction.kind === InteractionKind.QUESTION ? (
        <QuestionForm interaction={interaction} draft={draft} />
      ) : (
        <InteractionCard interaction={interaction} />
      )}
      {interaction.asynchronous && <Button title="Send a message" variant="ghost" size="sm" onPress={onClose} />}
    </Sheet>
  );
}

/** The 44 dp slot is always reserved. Sheets never affect the feed's measured composer reserve. */
export function QuestionPanel({
  interactions,
  subagents,
  disabled,
  style,
}: {
  interactions: readonly ui.Interaction[];
  subagents: readonly ui.Thread[];
  disabled: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const [children, setChildren] = useState<Record<string, ui.Interaction[]>>({});
  const [selected, setSelected] = useState<string>();

  const onChange = useCallback((id: string, requests: ui.Interaction[]) => {
    setChildren((previous) => ({ ...previous, [id]: requests }));
  }, []);

  const requests = [...interactions, ...subagents.flatMap((t) => children[t.id] ?? [])]
    .filter((q) => q.status === "pending")
    .sort((a, b) => Number(a.asynchronous) - Number(b.asynchronous));

  const active = requests.find((q) => q.requestId === selected) ?? requests[0];

  if (!active && selected !== undefined) setSelected(undefined);

  const draft = useQuestionDraft(
    active,
    requests.map((q) => q.requestId),
  );

  const index = requests.findIndex((q) => q.requestId === active?.requestId);
  const source = subagents.find((thread) => thread.id === active?.threadId);

  return (
    <View style={[{ height: 44, flexShrink: 0 }, style]}>
      {subagents.map((thread) => (
        <ChildQuestions key={thread.id} thread={thread} onChange={onChange} />
      ))}
      {active && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          accessibilityLabel={`${active.kind === InteractionKind.QUESTION ? "Answer questions" : "Review request"}. ${requests.length} pending`}
          onPress={() => setSelected(active.requestId)}
          style={({ pressed }) => [
            styles.row,
            { flex: 1, paddingHorizontal: 8, borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined },
          ]}
        >
          <Icon name="question-mark-circle" color={c.warning} />
          <Text numberOfLines={1} style={[styles.chrome, { flex: 1, minWidth: 0, color: c.text }]}>
            {active.kind === InteractionKind.QUESTION ? "Answer questions" : "Review request"}
          </Text>
          <Text style={[styles.chromeMeta, { color: c.muted }]}>{requests.length} pending</Text>
          <Icon name="chevron-right" color={c.muted} />
        </Pressable>
      )}
      {active && (
        <QuestionEditor
          interaction={active}
          draft={draft}
          visible={!disabled && selected !== undefined}
          onClose={() => setSelected(undefined)}
          label={source ? source.title || "Untitled thread" : undefined}
          navigation={
            requests.length > 1 && (
              <View style={[styles.row, { flexWrap: "wrap", gap: 16 }]}>
                <Text style={[styles.overlayMeta, { color: c.muted }]}>
                  Request {index + 1} of {requests.length}
                </Text>
                <Button
                  title="Previous"
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onPress={() => setSelected(requests[index - 1]?.requestId)}
                />
                <Button
                  title="Next request"
                  size="sm"
                  variant="ghost"
                  disabled={index + 1 === requests.length}
                  onPress={() => setSelected(requests[index + 1]?.requestId)}
                />
              </View>
            )
          }
        />
      )}
    </View>
  );
}
