import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Field, IconButton } from "../../ui/components";
import { SettingToggle } from "./SettingsGroup";

export type NoteDraft = Pick<ui.MemoryNote, "title" | "body" | "aliases" | "pinned">;

export function mergeNoteDraft(previous: ui.MemoryNote, draft: NoteDraft, latest: ui.MemoryNote): NoteDraft {
  return {
    title: previous.title === draft.title ? latest.title : draft.title,
    body: previous.body === draft.body ? latest.body : draft.body,
    aliases: sameAliases(previous, draft) ? latest.aliases : draft.aliases,
    pinned: previous.pinned === draft.pinned ? latest.pinned : draft.pinned,
  };
}

function sameAliases(previous: NoteDraft, draft: NoteDraft) {
  return (
    previous.aliases.length === draft.aliases.length && previous.aliases.every((value, i) => value === draft.aliases[i])
  );
}

export function noteChanged(previous: NoteDraft, draft: NoteDraft) {
  return (
    previous.title !== draft.title ||
    previous.body !== draft.body ||
    previous.pinned !== draft.pinned ||
    !sameAliases(previous, draft)
  );
}

export function MemoryNoteFields({
  draft,
  disabled,
  onChange,
}: {
  draft: NoteDraft;
  disabled: boolean;
  onChange: (draft: NoteDraft) => void;
}) {
  return (
    <>
      <Field
        label="Title"
        value={draft.title}
        multiline
        submitBehavior="newline"
        returnKeyType="default"
        maxLength={160}
        editable={!disabled}
        onChangeText={(title) => onChange({ ...draft, title })}
      />
      <Field
        label="Body"
        value={draft.body}
        maxLength={4000}
        editable={!disabled}
        onChangeText={(body) => onChange({ ...draft, body })}
        multiline
        returnKeyType="default"
        submitBehavior="newline"
        textAlignVertical="top"
        style={{ minHeight: 130 }}
      />
      {draft.aliases.map((alias, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Field
              label={`Alias ${index + 1}`}
              value={alias}
              editable={!disabled}
              maxLength={80}
              multiline
              submitBehavior="newline"
              returnKeyType="default"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) =>
                onChange({ ...draft, aliases: draft.aliases.map((current, i) => (i === index ? value : current)) })
              }
            />
          </View>
          <IconButton
            icon="trash"
            label={`Remove alias ${index + 1}`}
            disabled={disabled}
            onPress={() => onChange({ ...draft, aliases: draft.aliases.filter((_, i) => i !== index) })}
          />
        </View>
      ))}
      <Button
        title="Add alias"
        disabled={disabled || draft.aliases.length >= 8}
        onPress={() => onChange({ ...draft, aliases: [...draft.aliases, ""] })}
      />
      <SettingToggle
        title="Pin note"
        value={draft.pinned}
        disabled={disabled}
        onChange={(pinned) => onChange({ ...draft, pinned })}
      />
    </>
  );
}
