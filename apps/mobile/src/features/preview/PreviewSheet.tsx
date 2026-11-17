import { useState, type ReactNode } from "react";
import { Keyboard, Text, TextInput, View, useWindowDimensions } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { KeyboardWindow, useKeyboardFrame } from "../../ui/KeyboardWindow";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { useSession } from "../../state/session";
import { PreviewStage, PreviewStatus } from "./PreviewStage";
import { PreviewToolbar } from "./PreviewToolbar";
import { useAgentPreview } from "./useAgentPreview";

export function PreviewSheet({
  threadId,
  worker,
  visible,
  offline,
  onClose,
}: {
  threadId: string;
  worker?: ui.Worker;
  visible: boolean;
  offline: boolean;
  onClose: () => void;
}) {
  if (!visible) return null;

  return <PreviewBody key={threadId} threadId={threadId} worker={worker} offline={offline} onClose={onClose} />;
}

function PreviewBody({
  threadId,
  worker,
  offline,
  onClose,
}: {
  threadId: string;
  worker?: ui.Worker;
  offline: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const [controls, setControls] = useState(true);
  const { online } = useSession();
  const [tool, setTool] = useState(AgentTool.BROWSER);
  const [target, setTarget] = useState<AgentPreviewTarget>();
  const item = worker?.agentTools.find((entry) => entry.tool?.tool === tool);

  const ready =
    tool === AgentTool.DEVICE
      ? item?.tool?.installed && item.tool.version === "0.21.37" && item.tool.install?.state !== "running"
      : item?.tool?.ready;

  const unavailable = offline || !online || !worker?.online;
  const allowed = !unavailable && Boolean(item?.enabled && ready && !item.blockedReason);
  const preview = useAgentPreview({ threadId, tool, target, enabled: allowed });
  const live = allowed && ["ready", "frame"].includes(preview.state);
  const failed = ["error", "closed"].includes(preview.state);
  const targetId = target?.id || preview.targetId;

  return (
    <FullScreenViewer
      title="Preview"
      closeLabel="Close preview"
      onClose={onClose}
      onRequestClose={() => {
        if (Keyboard.isVisible() || KeyboardController.isVisible() || TextInput.State.currentlyFocusedInput()) {
          Keyboard.dismiss();
          void KeyboardController.dismiss();
        } else onClose();
      }}
      actions={
        <Button
          title={controls ? "Hide controls" : "Show controls"}
          variant="ghost"
          style={{ minWidth: 112 }}
          onPress={() => {
            Keyboard.dismiss();
            void KeyboardController.dismiss();
            setControls(!controls);
          }}
        />
      }
    >
      <KeyboardWindow preload={false}>
        <PreviewLayout>
          <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
            <PreviewStatus
              unavailable={unavailable}
              allowed={allowed}
              failed={failed}
              live={live}
              frame={Boolean(preview.frame)}
            />
          </View>
          <View style={{ flex: 1, minHeight: 0, flexDirection: compact && controls ? "row" : "column" }}>
            <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              <PreviewStage
                preview={preview}
                unavailable={unavailable}
                allowed={allowed}
                failed={failed}
                enabled={Boolean(item?.enabled)}
                live={live}
                scope={`${tool}:${targetId}`}
              />
            </View>
            <PreviewToolbar
              preview={preview}
              tool={tool}
              targetId={targetId}
              live={live}
              compact={compact}
              visible={controls}
              onToolChange={(value) => {
                setTool(value);
                setTarget(undefined);
              }}
              onTargetChange={setTarget}
            />
          </View>
          <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
              {preview.notice || `${worker?.name || "Computer"}${preview.title ? ` · ${preview.title}` : ""}`}
            </Text>
          </View>
        </PreviewLayout>
      </KeyboardWindow>
    </FullScreenViewer>
  );
}

/** Keep the return bar outside keyboard movement and all remote gesture responders. */
function PreviewLayout({ children }: { children: ReactNode }) {
  const keyboard = useKeyboardFrame();
  const { bottom } = useSafeAreaInsets();
  const style = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.get() - bottom) }));

  return <Animated.View style={[{ flex: 1, minHeight: 0 }, style]}>{children}</Animated.View>;
}
