import { useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { styles, useColors } from "../../ui/theme";
import { ImageViewer } from "./ImageViewer";
import type { ImageSource } from "./image-source";
import { useImage } from "./useImage";

export function ImagePreview({
  source,
  name,
  width = 0,
  height = 0,
}: {
  source: ImageSource;
  name: string;
  width?: number;
  height?: number;
}) {
  const c = useColors();
  const image = useImage(source, true);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <View style={{ maxWidth: "100%", gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open image ${name}`}
        onPress={() => setOpen(true)}
        style={{
          width: 240,
          maxWidth: "100%",
          height: Math.min(200, Math.max(80, width && height ? (240 * height) / width : 160)),
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: c.well,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {image.uri && !failed ? (
          <Image
            source={{ uri: image.uri }}
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
            onError={() => setFailed(true)}
          />
        ) : image.error || failed ? (
          <Text style={[styles.meta, { padding: 12, color: c.muted }]}>Tap to load the image</Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading preview" color={c.muted} />
        )}
      </Pressable>
      {open && <ImageViewer source={source} name={name} onClose={() => setOpen(false)} />}
    </View>
  );
}
