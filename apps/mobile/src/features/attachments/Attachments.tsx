import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { PickerSheet } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { fileSize, type useAttachmentDraft } from "./useAttachmentDraft";

type Draft = ReturnType<typeof useAttachmentDraft>;

/** The draft's files as removable chips above the message text. */
export function AttachmentChips({ draft }: { draft: Draft }) {
  const c = useColors();

  if (!draft.files.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 12 }}
    >
      {draft.files.map((f) => (
        <View
          key={f.key}
          style={[
            styles.row,
            {
              gap: 6,
              maxWidth: 220,
              minHeight: 36,
              paddingLeft: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: f.error ? c.danger : c.line,
              backgroundColor: c.inset,
            },
          ]}
        >
          {!f.attachment && !f.error ? (
            <ActivityIndicator size="small" color={c.muted} accessibilityLabel={`Uploading ${f.name}`} />
          ) : (
            <Icon
              name={f.error ? "exclamation-circle" : f.kind === "image" ? "photo" : "document-text"}
              size={14}
              color={f.error ? c.danger : c.muted}
            />
          )}
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={[styles.caption, { color: c.text }]}>
              {f.name}
            </Text>
            <Text numberOfLines={1} style={[styles.caption, { color: f.error ? c.danger : c.faint }]}>
              {f.error ?? fileSize(f.size)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${f.name}`}
            onPress={() => draft.remove(f.key)}
            hitSlop={6}
            style={{ width: 32, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="x-mark" size={14} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/** Paper clip in the composer: choose photos or files. */
export function AttachButton({ draft, disabled }: { draft: Draft; disabled?: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach files"
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? c.inset : "transparent",
          opacity: disabled ? 0.4 : 1,
        })}
      >
        <Icon name="paper-clip" />
      </Pressable>
      <PickerSheet
        title="Attach"
        visible={open}
        onClose={() => setOpen(false)}
        onSelect={(source) => void (source === "photos" ? draft.pickPhotos() : draft.pickFiles())}
        sections={[
          {
            options: [
              { value: "photos" as const, label: "Photos", icon: "photo" as const },
              { value: "files" as const, label: "Files", icon: "document-text" as const },
            ],
          },
        ]}
      />
    </>
  );
}
