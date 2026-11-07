import type { ReactNode } from "react";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native";
import type { IntakeFile, useAttachmentDraft } from "./useAttachmentDraft";

type Draft = ReturnType<typeof useAttachmentDraft>;

type FilesEvent = NativeSyntheticEvent<{ files: IntakeFile[] }>;

interface NativeProps {
  maxBytes: number;
  onFiles?: (event: FilesEvent) => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

// A development client built before modules/canopy-file-intake lacks the view: the composer stands alone.
const available = requireOptionalNativeModule("CanopyFileIntake") !== null;

const NativePaste = available ? requireNativeView<NativeProps>("CanopyFileIntake", "CanopyPasteView") : undefined;

/**
 * Around a composer: images and files pasted into its text (the system Paste, a keyboard's image or clipboard
 * strip) or dropped on it attach to `draft`; text pastes as before (docs/mobile.md, "Wklejanie i upuszczanie").
 */
export function PasteTarget({ draft, children }: { draft: Draft; children: ReactNode }) {
  if (!NativePaste) return children;

  return (
    <NativePaste maxBytes={draft.maxFileBytes} onFiles={(event) => draft.addIntake(event.nativeEvent.files)}>
      {children}
    </NativePaste>
  );
}
