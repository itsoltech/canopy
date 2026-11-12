import { useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "../../ui/TextInput";
import { ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { SheetDragArea } from "../../ui/SheetDragArea";
import { styles, useColors } from "../../ui/theme";
import { MessageSpans } from "../composer/MessageText";
import { editText, isAttachment, trimValue, type MessageValue } from "../composer/message-value";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import { inlineLegacyQuotes } from "@canopy/domain";

const failure = (cause: unknown) => ConnectError.from(cause).rawMessage;

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

  const initial: MessageValue = {
    ...inlineLegacyQuotes({ text: turn.messageText, quotes: turn.quotes }),
    mentions: turn.mentions,
  };

  const [value, setValue] = useState(initial);
  useUpdateBlocker(() => value.text !== initial.text || value.mentions.length !== initial.mentions.length);
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
        quotes: [...(trimmed.quotes ?? [])],
        quotesComplete: true,
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
      <SheetDragArea>
        <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
          Edit queued message
        </Text>
      </SheetDragArea>
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
