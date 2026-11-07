import { useState, type ReactNode } from "react";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform, Text, View, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "../../ui/Icon";
import { useMotion } from "../../ui/motion";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import type { IntakeFile, useAttachmentDraft } from "./useAttachmentDraft";

type Draft = ReturnType<typeof useAttachmentDraft>;

type FilesEvent = NativeSyntheticEvent<{ files: IntakeFile[] }>;

type DragStateEvent = NativeSyntheticEvent<{ over: boolean }>;

interface NativeProps {
  maxBytes: number;
  onFiles?: (event: FilesEvent) => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

// A development client built before modules/canopy-file-intake has neither view: plain views stand in.
const available = requireOptionalNativeModule("CanopyFileIntake") !== null;

const NativePaste = available ? requireNativeView<NativeProps>("CanopyFileIntake", "CanopyPasteView") : undefined;

const NativeDrop = available
  ? requireNativeView<NativeProps & { enabled: boolean; onDragState?: (event: DragStateEvent) => void }>(
      "CanopyFileIntake",
      "CanopyDropView",
    )
  : undefined;

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

/**
 * A thread screen on a large screen (iPad, split screen, foldables, desktop mode): files dragged from another app
 * show "Drop files to attach" over it and, dropped, attach to `draft`; `disabled` refuses them. The overlay takes no
 * space.
 */
export function DropZone({ draft, disabled, children }: { draft: Draft; disabled?: boolean; children: ReactNode }) {
  const [over, setOver] = useState(false);

  if (!NativeDrop) return <View style={styles.fill}>{children}</View>;

  const content = (
    <>
      {children}
      {over ? <DropOverlay /> : null}
    </>
  );

  // Always the same native view: switching it off must not remount the screen under it.
  return (
    <NativeDrop
      style={styles.fill}
      enabled={!disabled}
      maxBytes={draft.maxFileBytes}
      onDragState={(event) => setOver(event.nativeEvent.over)}
      onFiles={(event) => {
        setOver(false);
        draft.addIntake(event.nativeEvent.files);
      }}
    >
      {Platform.OS === "android" ? (
        // ExpoView is a LinearLayout: one real RN child keeps its absolute overlays in the same layout.
        <View style={styles.fill} collapsable={false}>
          {content}
        </View>
      ) : (
        content
      )}
    </NativeDrop>
  );
}

/** The web's FileDropOverlay: a dashed brand frame and a label, fading in on `fast` and out on `quick`. */
function DropOverlay() {
  const c = useColors();
  const { rise, pop } = useMotion();
  // Inside the floating header and the safe area, so the frame shows whole.
  const insets = useContentInsets();

  return (
    <Animated.View
      entering={rise.entering}
      exiting={rise.exiting}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        paddingTop: insets.top + 8,
        paddingRight: insets.right + 8,
        paddingBottom: insets.bottom + 8,
        paddingLeft: insets.left + 8,
      }}
    >
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 16,
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: c.brand,
          overflow: "hidden",
          // No backdrop blur here: the canvas veils the thread, the accent tints it as on the web.
          backgroundColor: `${c.background}e6`,
        }}
      >
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.softAccent }} />
        <Animated.View
          entering={pop.entering}
          style={[
            styles.row,
            {
              gap: 8,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: c.line,
              backgroundColor: c.surface,
            },
          ]}
        >
          <Icon name="paper-clip" size={16} color={c.text} />
          <Text style={[styles.label, { color: c.text }]}>Drop files to attach</Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}
