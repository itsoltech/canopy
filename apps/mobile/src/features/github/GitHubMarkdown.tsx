import type { GitHubImage as ImageValue } from "@canopy/domain/github-images";
import { githubImageUrl } from "@canopy/domain/github-images";
import { safeHref } from "@canopy/domain/markdown";
import { Image, Linking, Text, View, useWindowDimensions } from "react-native";
import { useState } from "react";
import { Markdown } from "../../ui/markdown/Markdown";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { useViewportVisibility } from "../../ui/viewport";
import { useColors } from "../../ui/theme";

function GitHubImage({
  value,
  pullRequestId,
  contentId,
}: {
  value: ImageValue;
  pullRequestId: string;
  contentId: string;
}) {
  const { client } = useSession();
  const c = useColors();
  const viewport = useViewportVisibility();
  const window = useWindowDimensions();
  const url = githubImageUrl(value.src);
  const small = !!value.width && !!value.height && value.width <= 64 && value.height <= 64;
  const width = Math.min(value.width ?? 800, Math.max(1, window.width - 80));
  const height = width * ((value.height ?? (value.width ? (value.width * 9) / 16 : 450)) / (value.width ?? 800));

  const read = useSharedQuery(
    `GitHubImage:${pullRequestId}:${contentId}:${url}`,
    () => client!.api.getPullRequestImage({ pullRequestId, contentId, url }),
    !!client && !!url && (small || viewport.visible),
    300_000,
  );

  const [failed, setFailed] = useState("");
  const source = read.data?.dataUrl;
  const href = safeHref(value.src);

  return (
    <View
      ref={viewport.ref}
      onLayout={viewport.onLayout}
      style={{ width, height, maxWidth: "100%", overflow: "hidden", backgroundColor: small ? undefined : c.inset }}
    >
      {!url || read.error || (source && failed === source) ? (
        <Text
          accessibilityRole={href ? "link" : undefined}
          onPress={
            href
              ? () => {
                  void Linking.openURL(href);
                }
              : undefined
          }
          style={{ color: c.sky }}
        >
          {value.alt || "Open image"}
        </Text>
      ) : source ? (
        <Image
          source={{ uri: source }}
          accessibilityLabel={value.alt}
          resizeMode="contain"
          style={{ width, height }}
          onError={() => setFailed(source)}
        />
      ) : null}
    </View>
  );
}

export function GitHubMarkdown({
  text,
  pullRequestId,
  contentId,
}: {
  text: string;
  pullRequestId: string;
  contentId: string;
}) {
  return (
    <Markdown
      text={text}
      image={(value) => <GitHubImage value={value} pullRequestId={pullRequestId} contentId={contentId} />}
    />
  );
}
