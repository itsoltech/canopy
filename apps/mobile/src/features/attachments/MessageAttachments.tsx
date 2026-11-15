import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ImagePreview } from "./ImagePreview";
import { AttachmentViewer } from "./AttachmentViewer";
import { ImageViewer } from "./ImageViewer";
import { VideoAttachment } from "./VideoAttachment";
import { attachmentPreviewKind } from "@canopy/domain/attachment-preview";

/** Images open in one viewer, so a message's images swipe from one to the next. */
export function MessageAttachments({ files, pending }: { files: readonly ui.Attachment[]; pending: boolean }) {
  const c = useColors();
  const [selected, setSelected] = useState<ui.Attachment>();
  const [image, setImage] = useState<number>();

  const images = useMemo(
    () =>
      files
        .filter((file) => file.kind === "image" && attachmentPreviewKind(file) !== "video")
        .map((file) => ({ key: file.id, source: { kind: "attachment" as const, file }, name: file.name })),
    [files],
  );

  return (
    <View
      style={[
        styles.row,
        { flexWrap: "wrap", justifyContent: "flex-end", gap: 4, opacity: pending ? 0.7 : 1, maxWidth: "100%" },
      ]}
    >
      {files.map((file) =>
        attachmentPreviewKind(file) === "video" ? (
          <VideoAttachment key={file.id} file={file} />
        ) : file.kind === "image" ? (
          <ImagePreview
            key={file.id}
            source={{ kind: "attachment", file }}
            name={file.name}
            width={file.width}
            height={file.height}
            onOpen={() => setImage(images.findIndex((item) => item.key === file.id))}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(file)}
            key={file.id}
            accessibilityLabel={`Attached ${file.name}`}
            style={[styles.row, { gap: 4, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.inset }]}
          >
            <Icon name="document-text" size={12} />
            <Text numberOfLines={1} style={[styles.caption, { color: c.body, maxWidth: 180 }]}>
              {file.name}
            </Text>
          </Pressable>
        ),
      )}
      {selected && <AttachmentViewer file={selected} onClose={() => setSelected(undefined)} />}
      {image !== undefined && images[image] ? (
        <ImageViewer images={images} index={image} onIndexChange={setImage} onClose={() => setImage(undefined)} />
      ) : null}
    </View>
  );
}
