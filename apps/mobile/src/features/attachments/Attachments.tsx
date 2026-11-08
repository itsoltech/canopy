import { useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "../../ui/Icon";
import { useMotion } from "../../ui/motion";
import { PickerSheet } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { fileSize, type DraftFile, type useAttachmentDraft } from "./useAttachmentDraft";

type Draft = ReturnType<typeof useAttachmentDraft>;

/**
 * Files still uploading or that failed, as removable chips above the text: their badges sit in the text, which
 * cannot show progress or a reason. A stored file has only its badge.
 */
export function AttachmentChips({ files, onRemove }: { files: DraftFile[]; onRemove: (key: string) => void }) {
  const c = useColors();
  const shown = files.filter((f) => !f.attachment);
  const { pop, layout } = useMotion();

  if (!shown.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 12 }}
    >
      {/* A chip pops in when added and out when removed; its neighbours glide aside (web `pop`, `reorder`). */}
      {shown.map((f) => (
        <Animated.View
          key={f.key}
          entering={pop.entering}
          exiting={pop.exiting}
          layout={layout}
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
            onPress={() => onRemove(f.key)}
            hitSlop={6}
            style={{ width: 32, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="x-mark" size={14} />
          </Pressable>
        </Animated.View>
      ))}
    </ScrollView>
  );
}

type Source = "photos" | "files" | "paste";

/**
 * Paper clip in the composer: choose photos or files, or paste the clipboard's image. Whether the clipboard holds
 * one is asked as the menu opens (no content is read, so no paste prompt); reading it waits for "Paste image".
 */
export function AttachButton({ draft, disabled }: { draft: Draft; disabled?: boolean }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const pending = useRef<Source | undefined>(undefined);

  async function show() {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    Keyboard.dismiss();
    setImage(await Clipboard.hasImageAsync().catch(() => false));
    setOpen(true);
  }

  async function dismissed() {
    const source = pending.current;
    pending.current = undefined;

    try {
      if (!source || disabled) return;
      await (source === "photos" ? draft.pickPhotos() : source === "files" ? draft.pickFiles() : draft.pasteImage());
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach files"
        disabled={disabled || busy}
        onPress={() => void show()}
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
        onSelect={(source) => {
          pending.current = source;
        }}
        onDismiss={() => void dismissed()}
        sections={[
          {
            options: [
              { value: "photos" as const, label: "Photos", icon: "photo" as const },
              { value: "files" as const, label: "Files", icon: "document-text" as const },
              ...(image
                ? [{ value: "paste" as const, label: "Paste image", icon: "clipboard-document" as const }]
                : []),
            ],
          },
        ]}
      />
    </>
  );
}
