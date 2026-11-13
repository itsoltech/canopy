import { useState } from "react";
import { Text, View } from "react-native";
import type { ImageGallery as Gallery } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { GalleryTile } from "./GalleryTile";
import { GalleryViewer } from "./GalleryViewer";

export function ImageGallery({ gallery }: { gallery: Gallery }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<number>();
  const images = expanded ? gallery.images : gallery.images.slice(0, 6);
  const rows = Array.from({ length: Math.ceil(images.length / 2) }, (_, row) => images.slice(row * 2, row * 2 + 2));

  return (
    <View style={{ gap: 8 }}>
      {gallery.caption ? <Text style={[styles.body, { color: c.text }]}>{gallery.caption}</Text> : null}
      {rows.map((row, index) => (
        <View key={row[0]!.attachmentId} style={{ flexDirection: "row", gap: 12 }}>
          {row.map((image, column) => (
            <GalleryTile key={image.attachmentId} image={image} onOpen={() => setSelected(index * 2 + column)} />
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
      {gallery.images.length > 6 ? (
        <Button
          variant="ghost"
          size="sm"
          style={{ alignSelf: "flex-start" }}
          title={expanded ? "Show fewer images" : `Show all ${gallery.images.length.toLocaleString()}`}
          onPress={() => setExpanded(!expanded)}
        />
      ) : null}
      {selected !== undefined ? (
        <GalleryViewer
          images={gallery.images}
          selected={selected}
          onSelect={setSelected}
          onClose={() => setSelected(undefined)}
        />
      ) : null}
    </View>
  );
}
