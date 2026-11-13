import { Linking, Text, View, useWindowDimensions } from "react-native";
import type { AgentMessage, GalleryImage } from "@canopy/contracts";
import type { GitHubImage } from "@canopy/domain/github-images";
import { safeHref } from "@canopy/domain/markdown";
import { localImagePath } from "@canopy/domain/markdown-images";
import { useFileLinks } from "../../ui/markdown/file-links";
import { useColors, useTypography } from "../../ui/theme";
import { GalleryTile } from "../attachments/GalleryTile";

export function MessageImage({
  value,
  message,
  streaming,
  onOpen,
}: {
  value: GitHubImage;
  message: AgentMessage;
  streaming: boolean;
  onOpen: (image: GalleryImage) => void;
}) {
  const c = useColors();
  const type = useTypography();
  const files = useFileLinks();
  const window = useWindowDimensions();
  const width = Math.min(320, Math.max(1, window.width - 80));
  const stored = message.images.find((image) => image.sourcePath === value.src);
  const path = localImagePath(value.src);
  const href = safeHref(value.src);

  if (stored)
    return (
      <View style={{ width, height: (width * 9) / 16, maxWidth: "100%" }}>
        <GalleryTile image={stored} onOpen={() => onOpen(stored)} showCaption={false} />
      </View>
    );

  if (path && streaming)
    return (
      <View
        style={{
          width,
          height: (width * 9) / 16,
          backgroundColor: c.well,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text accessibilityLiveRegion="polite" style={[type.small, { color: c.muted }]}>
          Preparing image…
        </Text>
      </View>
    );

  const fallback = (
    <Text
      accessibilityRole={(files && path) || href ? "link" : undefined}
      accessibilityHint={message.imageError || (path ? "Image not saved. Open the file." : undefined)}
      style={{ color: c.sky, textDecorationLine: "underline" }}
      onPress={() => {
        if (files && path) files(path);
        else if (href) void Linking.openURL(href).catch(() => undefined);
      }}
    >
      {value.alt || path || href}
    </Text>
  );

  return path ? (
    <View
      style={{
        width,
        height: (width * 9) / 16,
        borderRadius: 8,
        backgroundColor: c.well,
        justifyContent: "center",
        padding: 12,
      }}
    >
      {fallback}
    </View>
  ) : (
    fallback
  );
}
