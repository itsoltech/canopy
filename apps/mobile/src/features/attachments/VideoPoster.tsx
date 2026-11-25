import type { ui } from "@canopy/contracts";
import { Image, StyleSheet, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { useImage } from "./useImage";
import { useColors } from "../../ui/theme";

/** Only the gateway's raster thumbnail enters Image; the video itself never enters the image cache. */
export function VideoPoster({
  file,
  visible = true,
  showPlay = true,
}: {
  file: ui.Attachment;
  visible?: boolean;
  showPlay?: boolean;
}) {
  const c = useColors();
  const image = useImage({ kind: "attachment", file }, true, visible && file.hasThumbnail);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.well }}>
      {image.uri ? (
        <Image
          source={{ uri: image.uri }}
          resizeMode={showPlay ? "cover" : "contain"}
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      ) : null}
      {showPlay ? <Icon name="play" size={20} color={image.uri ? "#ffffff" : c.muted} /> : null}
    </View>
  );
}
