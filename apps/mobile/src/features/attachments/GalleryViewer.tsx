import { useMemo } from "react";
import type { GalleryImage } from "@canopy/contracts";
import { Segmented } from "../../ui/Segmented";
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
  const image = images[selected]!;

  const pages = useMemo(
    () =>
      images.map((item) => ({
        key: item.attachmentId,
        source: gallerySource(item),
        name: item.name,
        alt: item.alt,
        caption: item.caption || item.alt,
      })),
    [images],
  );

  const paired = image.pair && images.filter((other) => other.pair === image.pair).length === 2;

  return (
    <ImageViewer
      images={pages}
      index={selected}
      onIndexChange={onSelect}
      onClose={onClose}
      controls={
        paired ? (
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
        ) : null
      }
    />
  );
}
