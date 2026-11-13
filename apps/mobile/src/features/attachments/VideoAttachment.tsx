import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatVideoDuration } from "@canopy/domain";
import { styles, useColors } from "../../ui/theme";
import { useImageVisibility } from "./image-viewport";
import { VideoPoster } from "./VideoPoster";
import { AttachmentViewer } from "./AttachmentViewer";

export function VideoAttachment({ file }: { file: ui.Attachment }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const { ref, onLayout, visible } = useImageVisibility();

  return (
    <View ref={ref} onLayout={onLayout} collapsable={false} style={{ maxWidth: "100%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open video ${file.name}`}
        onPress={() => setOpen(true)}
        style={{ width: 240, maxWidth: "100%", gap: 4 }}
      >
        <View style={{ height: 135, borderRadius: 8, overflow: "hidden" }}>
          <VideoPoster file={file} visible={visible} />
        </View>
        <Text numberOfLines={1} style={[styles.caption, { color: c.text }]}>
          {file.name}
        </Text>
        <Text style={[styles.caption, { color: c.muted }]}>
          {["Video", formatVideoDuration(file.durationMs)].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {open ? <AttachmentViewer file={file} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}
