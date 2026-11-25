import { useState, type ReactNode } from "react";
import { Keyboard, TextInput, View, useWindowDimensions } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { KeyboardWindow, useKeyboardFrame } from "../../ui/KeyboardWindow";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { IconButton } from "../../ui/Button";
import { useSession } from "../../state/session";
import { PreviewNotice, PreviewStage, PreviewStatus } from "./PreviewStage";
import type { PreviewEditorKind } from "./PreviewEditor";
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
  const { width, height } = useWindowDimensions();
  const compact = height < 500 && width >= 600;
  const [controls, setControls] = useState(true);
  const [inspecting, setInspecting] = useState(false);
  const [editor, setEditor] = useState<{ kind: PreviewEditorKind; scope: string }>();
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
  const scope = `${tool}:${targetId}`;
  const [lastTarget, setLastTarget] = useState({ tool, id: targetId });
  const editorScope = `${tool}:${targetId || (lastTarget.tool === tool ? lastTarget.id : "")}`;
  const editing = editor?.scope === editorScope ? editor.kind : undefined;

  // A suspended connection empties the target temporarily. Keep the editor mounted for the same target.
  if (lastTarget.tool !== tool || (targetId && lastTarget.id !== targetId)) setLastTarget({ tool, id: targetId });

  function closeEditor() {
    setEditor(undefined);
    Keyboard.dismiss();
    void KeyboardController.dismiss();
  }

  return (
    <FullScreenViewer
      title="Preview"
      closeLabel="Close preview"
      supportedOrientations={["portrait", "landscape"]}
      onClose={onClose}
      onRequestClose={() => {
        if (Keyboard.isVisible() || KeyboardController.isVisible() || TextInput.State.currentlyFocusedInput()) {
          Keyboard.dismiss();
          void KeyboardController.dismiss();
        } else if (editing) closeEditor();
        else onClose();
      }}
      actions={
        <PreviewHeaderActions
          status={
            <PreviewStatus
              unavailable={unavailable}
              allowed={allowed}
              failed={failed}
              live={live}
              frame={Boolean(preview.frame)}
              inspecting={inspecting}
            />
          }
          inspecting={inspecting}
          canInspect={Boolean(preview.frame)}
          controls={controls}
          onInspect={() => setInspecting((value) => !value)}
          onToggleControls={() => {
            closeEditor();
            setControls((value) => !value);
          }}
        />
      }
    >
      <KeyboardWindow preload={false}>
        <PreviewLayout>
          <View style={{ flex: 1, minHeight: 0 }}>
            <PreviewStage
              preview={preview}
              unavailable={unavailable}
              allowed={allowed}
              failed={failed}
              enabled={Boolean(item?.enabled)}
              live={live}
              inspecting={inspecting}
              scope={scope}
            />
            <PreviewNotice text={preview.notice} />
          </View>
          <PreviewToolbar
            preview={preview}
            tool={tool}
            targetId={targetId}
            computer={worker?.name}
            live={live}
            compact={compact}
            visible={controls}
            editing={editing}
            editorScope={editorScope}
            onEdit={(kind) => setEditor({ kind, scope: editorScope })}
            onCloseEditor={closeEditor}
            onToolChange={(value) => {
              if (value === tool) return;
              setEditor(undefined);
              setTool(value);
              setTarget(undefined);
            }}
            onTargetChange={(value) => {
              setEditor(undefined);
              setTarget(value);
            }}
          />
        </PreviewLayout>
      </KeyboardWindow>
    </FullScreenViewer>
  );
}

function PreviewHeaderActions({
  status,
  inspecting,
  canInspect,
  controls,
  onInspect,
  onToggleControls,
}: {
  status: ReactNode;
  inspecting: boolean;
  canInspect: boolean;
  controls: boolean;
  onInspect: () => void;
  onToggleControls: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {status}
      <IconButton
        icon={inspecting ? "hand-raised" : "magnifying-glass"}
        label={inspecting ? "Control app" : "Inspect preview"}
        variant={inspecting ? "secondary" : "ghost"}
        disabled={!canInspect && !inspecting}
        onPress={onInspect}
      />
      <IconButton
        icon={controls ? "arrows-pointing-out" : "arrows-pointing-in"}
        label={controls ? "Hide preview toolbar" : "Show preview toolbar"}
        onPress={onToggleControls}
      />
    </View>
  );
}

/** Keep the return bar outside keyboard movement and all remote gesture responders. */
function PreviewLayout({ children }: { children: ReactNode }) {
  const keyboard = useKeyboardFrame();
  const { bottom } = useSafeAreaInsets();
  const style = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.get() - bottom) }));

  return <Animated.View style={[{ flex: 1, minHeight: 0 }, style]}>{children}</Animated.View>;
}
