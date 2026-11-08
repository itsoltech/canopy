import { useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Pressable } from "react-native";
import { Icon } from "../../ui/Icon";
import { PickerSheet } from "../../ui/Picker";
import { useColors } from "../../ui/theme";
import type { useAttachmentDraft } from "./useAttachmentDraft";

export { AttachmentChips } from "./AttachmentChips";

type Draft = ReturnType<typeof useAttachmentDraft>;

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
              { value: "photos" as const, label: "Photos and videos", icon: "photo" as const },
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
