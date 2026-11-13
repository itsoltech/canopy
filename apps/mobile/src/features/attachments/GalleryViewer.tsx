import { useMemo } from "react";
import { Text, View } from "react-native";
import type { GalleryImage } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { useColors, useTypography } from "../../ui/theme";
import { gallerySource } from "./gallery-source";
import { ImageViewer } from "./ImageViewer";

export function GalleryViewer({
  images,
  selected,
  onSelect,
  onClose,
}: {
  images: readonly GalleryImage[];
  selected: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const image = images[selected]!;
  const source = useMemo(() => gallerySource(image), [image]);
  const paired = image.pair && images.filter((other) => other.pair === image.pair).length === 2;
  const move = (direction: number) => onSelect((selected + direction + images.length) % images.length);

  return (
    <ImageViewer
      key={image.attachmentId}
      source={source}
      name={image.name}
      alt={image.alt}
      caption={image.caption || image.alt}
      onClose={onClose}
      controls={
        <View style={{ gap: 12 }}>
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
          {paired ? (
            <Segmented
              value={image.side}
              options={[
                { value: "before", label: "Before" },
                { value: "after", label: "After" },
              ]}
              onChange={(value) => {
                const index = images.findIndex((other) => other.pair === image.pair && other.side === value);

                if (index >= 0) onSelect(index);
              }}
            />
          ) : null}
        </View>
      }
    />
  );
}
