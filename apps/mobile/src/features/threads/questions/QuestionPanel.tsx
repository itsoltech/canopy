import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { InteractionKind, type Item, type ui } from "@canopy/contracts";
import { Button, Sheet } from "../../../ui/components";
import { RequestCountdown } from "../../../ui/RequestCountdown";
import { styles, useColors } from "../../../ui/theme";
import { useSession } from "../../../state/session";
import { useStream } from "../../../state/stream";
import { childRequestUpdates, hasChildRequests, type ChildRequests } from "./child-requests";
import { InteractionCard } from "../InteractionCard";
import { TrayPanel } from "../tray/ComposerTray";
import { TrayHeader, TrayIcon } from "../tray/TrayHeader";
import { QuestionForm } from "./QuestionForm";
import { useQuestionDraft } from "./useQuestionDraft";

/** Child requests and approval details stay separate from the parent's timeline. */
function ChildQuestions({ id, onChange }: { id: string; onChange: (id: string, value?: ChildRequests) => void }) {
  const { client } = useSession();
  const showing = useRef(false);
  useStream(
    client
      ? (signal) =>
          childRequestUpdates(client.api.watchThread({ threadId: id, pageSize: 1, requestsOnly: true }, { signal }))
      : null,
    (value) => {
      if (value || showing.current) onChange(id, value);
      showing.current = Boolean(value);
    },
    id,
  );
  useEffect(
    () => () => {
      if (showing.current) onChange(id);
      showing.current = false;
    },
    [id, onChange],
  );

  return null;
}

function QuestionEditor({
  interaction,
  visible,
  onClose,
  navigation,
  label,
  draft,
  related,
}: {
  interaction: ui.Interaction;
  visible: boolean;
  onClose: () => void;
  navigation: React.ReactNode;
  label?: string;
  draft: ReturnType<typeof useQuestionDraft>;
  related?: Item;
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
        <InteractionCard key={interaction.requestId} interaction={interaction} related={related} />
      )}
      {interaction.asynchronous && <Button title="Send a message" variant="ghost" size="sm" onPress={onClose} />}
    </Sheet>
  );
}

/**
 * The thread's pending requests, its subagents' included: each subagent's requests come from its own stream, so the
 * returned watchers must stay mounted. Synchronous requests come first.
 */
export function useThreadRequests(interactions: readonly ui.Interaction[], subagents: readonly ui.Thread[]) {
  const [children, setChildren] = useState<Record<string, ChildRequests>>({});
  const watching = subagents.filter(hasChildRequests);

  const onChange = useCallback((id: string, value?: ChildRequests) => {
    setChildren((previous) => {
      if (value) return { ...previous, [id]: value };
      const next = { ...previous };
      delete next[id];

      return next;
    });
  }, []);

  const requests = [...interactions, ...watching.flatMap((t) => children[t.id]?.requests ?? [])]
    .filter((q) => q.status === "pending")
    .sort((a, b) => Number(a.asynchronous) - Number(b.asynchronous));

  return {
    requests,
    subagents,
    /** Approval details from a subagent's stream. */
    items: (threadId: string) => children[threadId]?.items ?? [],
    watchers: watching.map((thread) => <ChildQuestions key={thread.id} id={thread.id} onChange={onChange} />),
  };
}

export type ThreadRequests = ReturnType<typeof useThreadRequests>;

/**
 * The tray's request row: what waits for you, with the first request's deadline, opening the sheet that answers
 * questions and reviews approvals one request at a time.
 */
export function QuestionPanel({
  requests: { requests, subagents, items: childItems },
  disabled,
  items = [],
}: {
  requests: ThreadRequests;
  disabled: boolean;
  items?: readonly ui.TimelineItem[];
}) {
  const c = useColors();
  const [selected, setSelected] = useState<string>();
  const active = requests.find((q) => q.requestId === selected) ?? requests[0];

  if (!active && selected !== undefined) setSelected(undefined);

  const draft = useQuestionDraft(
    active,
    requests.map((q) => q.requestId),
  );

  const index = requests.findIndex((q) => q.requestId === active?.requestId);
  const source = subagents.find((thread) => thread.id === active?.threadId);
  const title = active?.kind === InteractionKind.QUESTION ? "Answer questions" : "Review request";

  if (!active) return null;

  return (
    <TrayPanel>
      <TrayHeader
        label={`${title}. ${requests.length} pending`}
        opens="sheet"
        disabled={disabled}
        onPress={() => setSelected(active.requestId)}
      >
        <TrayIcon name="question-mark-circle" color={c.warning} />
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, minWidth: 0, color: c.text }]}>
          {title}
        </Text>
        <RequestCountdown expiresAt={active.expiresAt} pending style={{ minWidth: 0 }} />
        <Text style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          {requests.length} pending
        </Text>
      </TrayHeader>
      <QuestionEditor
        interaction={active}
        draft={draft}
        related={
          [...items, ...(source ? childItems(source.id) : [])].find((entry) => entry.item?.itemId === active.itemId)
            ?.item
        }
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
    </TrayPanel>
  );
}
