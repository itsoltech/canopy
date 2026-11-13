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

  const safe =
    file.imageWidth > 0 &&
    file.imageHeight > 0 &&
    file.imageWidth * file.imageHeight <= 16_000_000 &&
    !file.imagePreviewError;

  const uri = useMemo(
    () =>
      safe
        ? `data:${file.imagePreview.length ? "image/png" : file.mimeType};base64,${base64Encode(file.imagePreview.length ? file.imagePreview : file.content)}`
        : "",
    [file, safe],
  );

  return (
    <View style={{ gap: 8 }}>
      {!safe ? (
        <Text style={[styles.body, { color: c.muted }]}>
          {file.imagePreviewError || "Update Canopy on the thread’s computer to preview this image safely."}
        </Text>
      ) : failed ? (
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
          onLoad={({ nativeEvent: { source } }) =>
            setDimensions(`${source.width.toLocaleString()} × ${source.height.toLocaleString()}`)
          }
        />
      )}
      <Text style={[styles.caption, { color: c.muted, textAlign: "center", fontVariant: ["tabular-nums"] }]}>
        {dimensions ? `${dimensions} · ` : ""}
        {formatBytes(file.size)}
      </Text>
    </View>
  );
}
