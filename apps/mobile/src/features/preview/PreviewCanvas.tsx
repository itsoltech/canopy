import { useRef, useState } from "react";
import { Image, Text, View, type GestureResponderEvent } from "react-native";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, type AgentPreviewEvent, type AgentPreviewInput } from "@canopy/contracts";
import { styles, useColors } from "../../ui/theme";

/** Capture only the fitted image, so letterboxing never becomes a remote click. */
export function PreviewCanvas({
  frame,
  uri,
  enabled,
  input,
}: {
  frame?: AgentPreviewEvent;
  uri?: string;
  enabled: boolean;
  input: (value: AgentPreviewInput) => void;
}) {
  const c = useColors();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(false);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const scale = frame ? Math.min(box.width / frame.width, box.height / frame.height, 1) : 0;
  const width = frame ? frame.width * scale : 0;
  const height = frame ? frame.height * scale : 0;
  const interactive = enabled && loaded;

  function point(event: GestureResponderEvent) {
    return {
      x: Math.max(0, Math.min(1, event.nativeEvent.locationX / width)),
      y: Math.max(0, Math.min(1, event.nativeEvent.locationY / height)),
    };
  }

  function release(event: GestureResponderEvent) {
    const from = start.current;
    start.current = undefined;

    if (!from || !interactive) return;
    const to = point(event);
    input(create(AgentPreviewInputSchema, { kind: "pointer-down", ...from, button: 0, buttons: 1 }));

    if (Math.abs(to.x - from.x) * width + Math.abs(to.y - from.y) * height > 8)
      input(create(AgentPreviewInputSchema, { kind: "pointer-move", ...to, buttons: 1 }));
    input(create(AgentPreviewInputSchema, { kind: "pointer-up", ...to, button: 0 }));
  }

  return (
    <View
      onLayout={(event) => setBox(event.nativeEvent.layout)}
      style={{ flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", backgroundColor: c.well }}
    >
      {uri && frame && width > 0 && height > 0 ? (
        <View
          accessibilityLabel="Live preview"
          accessibilityHint="Tap to click. Swipe to drag. Use the controls below to scroll or type."
          onStartShouldSetResponder={() => interactive}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(event) => {
            start.current = point(event);
          }}
          onResponderRelease={release}
          onResponderTerminate={() => {
            start.current = undefined;
          }}
          style={{ width, height }}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(false)}
            pointerEvents="none"
            style={{ width: "100%", height: "100%" }}
          />
        </View>
      ) : (
        <Text style={[styles.overlay, { color: c.muted, padding: 20, textAlign: "center" }]}>
          Waiting for the first live frame…
        </Text>
      )}
    </View>
  );
}
