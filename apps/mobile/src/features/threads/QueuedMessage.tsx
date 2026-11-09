import { useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "../../ui/TextInput";
import { ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { PickerSheet } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { MessageSpans } from "../composer/MessageText";
import { editText, isAttachment, trimValue, type MessageValue } from "../composer/message-value";

const failure = (cause: unknown) => ConnectError.from(cause).rawMessage;

/** A queued message's actions, as the web queue row offers them: edit it in place or delete it. */
export function QueuedMessageMenu({
  turn,
  running,
  onClose,
  onEdit,
  onError,
}: {
  turn: ui.Turn | undefined;
  running: boolean;
  onClose: () => void;
  onEdit: (turn: ui.Turn) => void;
  onError: (message: string) => void;
}) {
  const { client } = useSession();

  return (
    <PickerSheet
      title="Queued message"
      visible={Boolean(turn)}
      onClose={onClose}
      onSelect={(action) => {
        if (!turn) return;

        if (action === "edit") onEdit(turn);
        else if (action === "steer")
          void client?.api
            .steerQueuedTurn({ turnId: turn.id })
            .catch(() => onError("Could not steer the message. Check the queue, then try again."));
        else
          void client?.api
            .deleteQueuedTurn({ turnId: turn.id })
            .catch((cause: unknown) => onError(`Could not delete: ${failure(cause)}`));
      }}
      sections={[
        {
          options: [
            ...(running
              ? [{ value: "steer" as const, label: "Steer now", icon: "arrow-turn-down-right" as const }]
              : []),
            { value: "edit" as const, label: "Edit message", icon: "pencil-square" as const },
            { value: "delete" as const, label: "Delete", icon: "trash" as const, tone: "danger" as const },
          ],
        },
      ]}
    />
  );
}

/**
 * Edit of a queued message (it keeps its place and overrides): its files are the same badges as in the composer and
 * go whole when deleted; a file whose badge is gone leaves the message on Save, which the line under the field says.
 */
export function QueueEditor({ turn, onClose }: { turn: ui.Turn | undefined; onClose: () => void }) {
  return (
    <Overlay visible={Boolean(turn)} onClose={onClose} label="Edit queued message">
      {turn ? <EditorBody key={`${turn.id}:${turn.revision}`} turn={turn} onClose={onClose} /> : null}
    </Overlay>
  );
}

function EditorBody({ turn, onClose }: { turn: ui.Turn; onClose: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const initial: MessageValue = { text: turn.messageText, mentions: turn.mentions };
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const leaving = initial.mentions.flatMap((m) =>
    isAttachment(m) && !value.mentions.some((x) => x.kind === m.kind && x.name === m.name) ? [m.label || "a file"] : [],
  );

  const allowEmpty = turn.attachments.length > leaving.length;

  async function save() {
    if (!client || saving) return;
    const trimmed = trimValue(value);

    if (trimmed.text === turn.messageText && value.mentions.length === initial.mentions.length) return onClose();
    setSaving(true);
    setError("");

    try {
      await client.api.editQueuedTurn({
        turnId: turn.id,
        text: trimmed.text,
        expectedRevision: turn.revision,
        mentions: [...trimmed.mentions],
        mentionsComplete: true,
      });
      onClose();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ padding: 16, gap: 12 }}>
      <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
        Edit queued message
      </Text>
      <TextInput
        accessibilityLabel="Edit queued message"
        autoFocus
        multiline
        maxLength={32000}
        onChangeText={(next) => setValue((v) => editText(v, next).value)}
        style={[
          styles.input,
          { maxHeight: 200, color: c.text, borderColor: c.line, backgroundColor: c.surface, textAlignVertical: "top" },
        ]}
      >
        <MessageSpans value={value} />
      </TextInput>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
          {error}
        </Text>
      ) : leaving.length ? (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
          {leaving.length === 1 ? `${leaving[0]} leaves` : `${leaving.length} files leave`} the message when you save.
        </Text>
      ) : null}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <Button title="Cancel" onPress={onClose} />
        <Button
          variant="primary"
          title="Save"
          busy={saving}
          disabled={!allowEmpty && !value.text.trim()}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
