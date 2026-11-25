import type { PublishedVideo } from "@canopy/contracts";
import { StyleSheet, Text, View } from "react-native";
import { styles, useColors } from "../../ui/theme";
import { VideoAttachment } from "./VideoAttachment";

const layout = StyleSheet.create({
  container: { gap: 8 },
});

export function PublishedVideoView({ video }: { video: PublishedVideo }) {
  const c = useColors();

  return (
    <View style={layout.container}>
      {video.caption ? <Text style={[styles.body, { color: c.text }]}>{video.caption}</Text> : null}
      {video.attachment?.id ? (
        <VideoAttachment file={video.attachment} />
      ) : (
        <Text style={[styles.caption, { color: c.muted }]}>Video unavailable</Text>
      )}
    </View>
  );
}
