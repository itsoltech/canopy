import { useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { base64Encode } from "@bufbuild/protobuf/wire";
import type { ui } from "@canopy/contracts";
import { formatBytes } from "@canopy/domain/format";
import { styles, useColors } from "../../ui/theme";

/** Only sniffed raster MIME types reach this view. No markup or external resource is loaded. */
export function ThreadFileImage({ file, name }: { file: ui.ThreadFile; name: string }) {
  const c = useColors();
  const [dimensions, setDimensions] = useState("");
  const [failed, setFailed] = useState(false);
  const uri = useMemo(() => `data:${file.mimeType};base64,${base64Encode(file.content)}`, [file]);

  return (
    <View style={{ gap: 8 }}>
      {failed ? (
        <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
          Could not show this image. Reload to try again.
        </Text>
      ) : (
        <Image
          source={{ uri }}
          accessibilityLabel={name}
          resizeMode="contain"
          style={{ width: "100%", height: 320 }}
          onError={() => setFailed(true)}
          onLoad={({ nativeEvent: { source } }) => setDimensions(`${source.width.toLocaleString()} × ${source.height.toLocaleString()}`)}
        />
      )}
      <Text style={[styles.caption, { color: c.muted, textAlign: "center", fontVariant: ["tabular-nums"] }]}>
        {dimensions ? `${dimensions} · ` : ""}{formatBytes(file.size)}
      </Text>
    </View>
  );
}
