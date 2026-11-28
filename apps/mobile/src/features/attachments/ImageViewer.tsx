import { useState, type ReactNode } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
import { base64Decode } from "@bufbuild/protobuf/wire";
import { isHeicAttachment } from "@canopy/domain/attachment-preview";
import { File } from "expo-file-system";
import { Button, IconButton } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors, useTypography } from "../../ui/theme";
import { ImagePager, type ViewerImage } from "./ImagePager";
import { useImagePagerModel } from "./image-pager-model";
import { useImage } from "./useImage";
import { exportFile } from "./export-file";

export type { ViewerImage };

/**
 * Full-screen images: swipe between them, pinch or double-tap to zoom, drag down to close. With more than one
 * image, Previous and Next stay as buttons for screen readers and one-handed use; they wrap around, swipes stop
 * at either end.
 */
export function ImageViewer({
  images,
  index = 0,
  onIndexChange,
  controls,
  onClose,
}: {
  images: readonly ViewerImage[];
  index?: number;
  onIndexChange?: (index: number) => void;
  controls?: ReactNode;
  onClose: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const [own, setOwn] = useState(index);
  const selected = onIndexChange ? index : own;
  const select = onIndexChange ?? setOwn;
  const current = images[selected]!;
  const image = useImage(current.source);
  const model = useImagePagerModel(selected, images.length, select);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const caption = current.caption;
  const move = (direction: number) => select((selected + direction + images.length) % images.length);

  const fade = useDerivedValue(
    () => 1 - Math.min(1, Math.abs(model.dismissY.get()) / ((model.viewport.get().height || 1) * 0.6)),
  );

  const chrome = useAnimatedStyle(() => ({ opacity: fade.get() }));

  async function save() {
    if (busy || !image.uri) return;
    setBusy(true);
    setError("");

    try {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(image.uri);
      const encoded = match?.[2];
      const bytes = encoded !== undefined ? base64Decode(encoded) : await new File(image.uri).bytes();
      const source = current.source;
      const mime = source.kind === "attachment" ? source.file.mimeType : source.kind === "local" ? source.mimeType : "";
      const mimeType = match?.[1] || (mime && isHeicAttachment(mime) ? mime : "application/octet-stream");
      await exportFile(current.name, bytes, mimeType);
    } catch {
      setError("Could not export the image. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FullScreenViewer
      title={current.name}
      onClose={onClose}
      fade={fade}
      actions={
        <IconButton
          icon="arrow-down"
          label={Platform.OS === "android" ? "Save image" : "Share image"}
          busy={busy}
          disabled={!image.uri}
          onPress={() => void save()}
        />
      }
    >
      <ImagePager model={model} images={images} index={selected} onClose={onClose} />
      {caption || controls || images.length > 1 ? (
        <Animated.View style={[{ padding: 12, gap: 12, borderTopWidth: 1, borderColor: c.rule }, chrome]}>
          {images.length > 1 ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Button title="Previous" label="Previous image" variant="ghost" onPress={() => move(-1)} />
              <Text
                accessibilityLiveRegion="polite"
                style={[type.small, { color: c.text, fontVariant: ["tabular-nums"] }]}
              >
                {(selected + 1).toLocaleString()} / {images.length.toLocaleString()}
              </Text>
              <Button title="Next" label="Next image" variant="ghost" onPress={() => move(1)} />
            </View>
          ) : null}
          {controls}
          {caption ? (
            <ScrollView style={{ maxHeight: 100 }}>
              <Text style={[type.small, { color: c.soft }]}>{caption}</Text>
            </ScrollView>
          ) : null}
        </Animated.View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { padding: 12, color: c.danger }]}>
          {error}
        </Text>
      ) : null}
    </FullScreenViewer>
  );
}
