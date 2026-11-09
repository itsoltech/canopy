import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ImagePreview } from "./ImagePreview";

export function MessageAttachments({ files, pending }: { files: readonly ui.Attachment[]; pending: boolean }) {
  const c = useColors();

  return (
    <View
      style={[
        styles.row,
        { flexWrap: "wrap", justifyContent: "flex-end", gap: 4, opacity: pending ? 0.7 : 1, maxWidth: "100%" },
      ]}
    >
      {files.map((file) =>
        file.kind === "image" ? (
          <ImagePreview
            key={file.id}
            source={{ kind: "attachment", file }}
            name={file.name}
            width={file.width}
            height={file.height}
          />
        ) : (
          <View
            key={file.id}
            accessibilityLabel={`Attached ${file.name}`}
            style={[styles.row, { gap: 4, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.inset }]}
          >
            <Icon name="document-text" size={12} />
            <Text numberOfLines={1} style={[styles.caption, { color: c.body, maxWidth: 180 }]}>
              {file.name}
            </Text>
          </View>
        ),
      )}
    </View>
  );
}
