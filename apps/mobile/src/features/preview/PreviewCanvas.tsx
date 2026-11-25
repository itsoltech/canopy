import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, type AgentPreviewEvent, type AgentPreviewInput } from "@canopy/contracts";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { styles, useColors } from "../../ui/theme";
import type { Point, Size } from "../attachments/image-zoom";
import { PreviewCursor } from "./PreviewCursor";
import { usePreviewGestures } from "./preview-gestures";
import { usePreviewZoom } from "./preview-zoom";

export function PreviewCanvas({
  frame,
  uri,
  enabled,
  inspecting,
  input,
}: {
  frame?: AgentPreviewEvent;
  uri?: string;
  enabled: boolean;
  inspecting: boolean;
  input: (value: AgentPreviewInput) => void;
}) {
  const c = useColors();

  if (uri && frame) {
    return (
      <PreviewImage
        key={`${frame.previewId}:${frame.targetId}`}
        frame={frame}
        uri={uri}
        enabled={enabled}
        inspecting={inspecting}
        input={input}
      />
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", backgroundColor: c.well }}>
      <Text style={[styles.overlay, { color: c.muted, padding: 20, textAlign: "center" }]}>
        Waiting for the first live frame…
      </Text>
    </View>
  );
}

function PreviewImage({
  frame,
  uri,
  enabled,
  inspecting,
  input,
}: {
  frame: AgentPreviewEvent;
  uri: string;
  enabled: boolean;
  inspecting: boolean;
  input: (value: AgentPreviewInput) => void;
}) {
  const c = useColors();
  const [loadedUri, setLoadedUri] = useState<string>();
  const [fitted, setFitted] = useState<Size>({ width: 0, height: 0 });
  const loaded = Boolean(loadedUri);
  const model = usePreviewZoom(frame.width, frame.height);
  const { geometry, read, viewport, adjust } = model;
  const remote = useRef<typeof input | undefined>(undefined);

  useLayoutEffect(() => {
    remote.current = enabled && loaded && !inspecting ? input : undefined;

    return () => {
      remote.current = undefined;
    };
  }, [enabled, loaded, inspecting, input]);

  const sendPointer = useCallback((from: Point, to: Point, drag: boolean) => {
    const send = remote.current;

    if (!send) return;
    send(create(AgentPreviewInputSchema, { kind: "pointer-down", ...from, button: 0, buttons: 1 }));

    if (drag) send(create(AgentPreviewInputSchema, { kind: "pointer-move", ...to, buttons: 1 }));
    send(create(AgentPreviewInputSchema, { kind: "pointer-up", ...to, button: 0 }));
  }, []);

  const gesture = usePreviewGestures(model, enabled && loaded, inspecting, sendPointer);

  const imageStyle = useAnimatedStyle(() => {
    const { scale, offset } = read();

    return { ...geometry.get().fitted, transform: [{ translateX: offset.x }, { translateY: offset.y }, { scale }] };
  });

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Live preview"
        accessibilityHint={
          inspecting
            ? "Adjust to zoom. Choose Control app to send touch input."
            : "Adjust to zoom. Touches with one finger control the app."
        }
        accessibilityActions={[
          { name: "increment", label: "Zoom in" },
          { name: "decrement", label: "Zoom out" },
          { name: "reset", label: "Reset zoom" },
        ]}
        onAccessibilityAction={({ nativeEvent }) => scheduleOnUI(adjust, nativeEvent.actionName)}
        onLayout={({ nativeEvent: { layout } }) => viewport.set({ width: layout.width, height: layout.height })}
        style={{
          flex: 1,
          minHeight: 0,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: c.well,
        }}
      >
        <Animated.View
          pointerEvents="none"
          onLayout={({ nativeEvent: { layout } }) => setFitted({ width: layout.width, height: layout.height })}
          style={[imageStyle, { overflow: "hidden" }]}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            fadeDuration={0}
            onLoad={({ nativeEvent }) => {
              if (nativeEvent.source.uri === uri) setLoadedUri(uri);
            }}
            onError={() => setLoadedUri(undefined)}
            style={{ width: "100%", height: "100%" }}
          />
          {loaded && frame.mode === "screenshots" && fitted.width > 0 && fitted.height > 0 && (
            <PreviewCursor
              cursor={frame.cursor}
              loaded={loadedUri === uri}
              width={fitted.width}
              height={fitted.height}
            />
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
