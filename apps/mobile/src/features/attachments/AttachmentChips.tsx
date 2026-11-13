import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "../../ui/Icon";
import { useMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { fileFormat, videoDuration } from "./attachment-display";
import { fileSize, type DraftFile } from "./useAttachmentDraft";
import { ImageViewer } from "./ImageViewer";
import { AttachmentViewer } from "./AttachmentViewer";
import { useImage } from "./useImage";

/** All draft files remain here until sent or removed, independently of their inline badges. */
export function AttachmentChips({ files, onRemove }: { files: DraftFile[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 12, alignItems: "center" }}
    >
      {files.map((file) => (
        <AttachmentChip key={file.key} file={file} onRemove={onRemove} />
      ))}
    </ScrollView>
  );
}

function AttachmentChip({ file, onRemove }: { file: DraftFile; onRemove: (key: string) => void }) {
  const c = useColors();
  const { pop, layout } = useMotion();
  const media = file.kind !== "file";
  const [viewing, setViewing] = useState(false);

  const format =
    file.kind === "image"
      ? { icon: "photo" as const, label: "Image" }
      : file.kind === "video"
        ? { icon: "play" as const, label: "Video" }
        : fileFormat(file.name, file.mimeType);

  const uploading = !file.attachment && !file.error;
  const status = file.error ?? (uploading ? "Uploading…" : "Attached");
  const duration = file.kind === "video" ? videoDuration(file.attachment?.durationMs || file.duration) : undefined;

  return (
    <Animated.View
      entering={pop.entering}
      exiting={pop.exiting}
      layout={layout}
      style={[
        styles.row,
        {
          gap: 6,
          width: media ? 240 : 208,
          height: 72,
          paddingLeft: media ? 3 : 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: file.error ? c.danger : c.line,
          backgroundColor: c.inset,
        },
      ]}
    >
      <Pressable
        accessibilityRole={file.attachment || (file.kind === "image" && file.previewUri) ? "button" : undefined}
        onPress={file.attachment || (file.kind === "image" && file.previewUri) ? () => setViewing(true) : undefined}
        accessibilityLabel={`${format.label}, ${file.name}, ${fileSize(file.size)}${duration ? `, ${duration}` : ""}. ${status}`}
        style={[styles.row, { flex: 1, minWidth: 0, gap: 8 }]}
      >
        {media ? (
          <MediaTile file={file} uploading={uploading} />
        ) : (
          <View style={{ width: 16, alignItems: "center" }}>
            {uploading ? (
              <ActivityIndicator size="small" color={c.muted} />
            ) : (
              <Icon name={format.icon} color={c.muted} />
            )}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.caption, { color: c.text }]}>
            {file.name}
          </Text>
          <Text numberOfLines={1} style={[styles.caption, { color: c.muted }]}>
            {format.label} · {fileSize(file.size)}
          </Text>
          {file.error ? (
            <Text numberOfLines={2} style={[styles.caption, { color: c.danger }]}>
              {file.error}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.name}`}
        onPress={() => onRemove(file.key)}
        style={({ pressed }) => ({
          width: 32,
          height: 56,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          backgroundColor: pressed ? c.pressed : "transparent",
        })}
      >
        <Icon name="x-mark" size={14} />
      </Pressable>
      {viewing && file.attachment ? (
        <AttachmentViewer file={file.attachment} onClose={() => setViewing(false)} />
      ) : viewing && file.previewUri ? (
        <ImageViewer
          source={{ kind: "local", uri: file.previewUri }}
          name={file.name}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </Animated.View>
  );
}

/** No video decoder is installed: use a play tile and the picker's duration without adding native code. */
function MediaTile({ file, uploading }: { file: DraftFile; uploading: boolean }) {
  const c = useColors();
  const [unreadable, setUnreadable] = useState(false);
  const duration = videoDuration(file.attachment?.durationMs || file.duration);

  const image = useImage(
    file.attachment ? { kind: "attachment", file: file.attachment } : { kind: "local", uri: file.previewUri ?? "" },
    true,
    Boolean(file.attachment && (file.kind === "image" || file.attachment.hasThumbnail)),
  );

  const preview =
    file.attachment && (file.kind === "image" || file.attachment.hasThumbnail) ? image.uri : file.previewUri;

  return (
    <View
      style={{
        width: 56,
        height: 56,
        borderRadius: 8,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.surface,
      }}
    >
      {preview && !unreadable ? (
        <Image
          source={{ uri: preview }}
          resizeMode="cover"
          style={StyleSheet.absoluteFill}
          accessible={false}
          onError={() => setUnreadable(true)}
        />
      ) : (
        <Icon name={file.kind === "video" ? "play" : "photo"} size={20} color={c.muted} />
      )}
      {file.kind === "video" && duration ? (
        <Text
          style={[
            styles.caption,
            {
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              textAlign: "center",
              color: c.text,
              backgroundColor: c.surface,
              fontVariant: ["tabular-nums"],
            },
          ]}
        >
          {duration}
        </Text>
      ) : null}
      {uploading || file.error ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: `${c.surface}66`,
            },
          ]}
        >
          {file.error ? (
            <Icon name="exclamation-circle" color={c.danger} />
          ) : (
            <ActivityIndicator size="small" color={c.text} />
          )}
        </View>
      ) : null}
    </View>
  );
}
