import { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import type { GalleryImage } from "@canopy/contracts";
import { styles, useColors, useTypography } from "../../ui/theme";
import { Button } from "../../ui/Button";
import { useImageVisibility } from "./image-viewport";
import { gallerySource } from "./gallery-source";
import { useImage } from "./useImage";

export function GalleryTile({
  image,
  onOpen,
  showCaption = true,
}: {
  image: GalleryImage;
  onOpen: () => void;
  showCaption?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const source = useMemo(() => gallerySource(image), [image]);
  const { ref, onLayout, visible } = useImageVisibility();
  const preview = useImage(source, true, visible && image.hasThumbnail);
  const [failed, setFailed] = useState(false);
  const caption = image.caption || image.alt;
  const side = image.side === "before" ? "Before" : image.side === "after" ? "After" : "";

  return (
    <View ref={ref} onLayout={onLayout} collapsable={false} style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <View style={{ aspectRatio: 16 / 9, borderRadius: 8, overflow: "hidden", backgroundColor: c.well }}>
        {preview.error || failed ? (
          <View style={{ flex: 1, justifyContent: "center", padding: 8 }}>
            <Button
              title="Retry"
              variant="ghost"
              size="sm"
              onPress={() => {
                setFailed(false);
                preview.retry();
              }}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open image: ${image.alt}`}
            onPress={onOpen}
            style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
          >
            {preview.uri ? (
              <Image
                source={{ uri: preview.uri }}
                accessibilityLabel={image.alt}
                resizeMode="contain"
                style={{ width: "100%", height: "100%" }}
                onError={() => setFailed(true)}
              />
            ) : visible && image.hasThumbnail ? (
              <ActivityIndicator accessibilityLabel="Loading preview" color={c.muted} />
            ) : (
              <Text style={[styles.meta, { color: c.muted }]}>Open image</Text>
            )}
          </Pressable>
        )}
      </View>
      {showCaption ? (
        <View style={{ minHeight: 52, gap: 2 }}>
          {side ? <Text style={[type.small, { color: c.text }]}>{side}</Text> : null}
          <Text numberOfLines={2} accessibilityLabel={caption} style={[type.small, { color: c.muted }]}>
            {caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
