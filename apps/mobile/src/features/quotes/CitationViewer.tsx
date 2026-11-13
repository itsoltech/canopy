import { ScrollView, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { citationPreview } from "@canopy/domain";
import { safeHref } from "@canopy/domain/markdown";
import * as Linking from "expo-linking";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { Markdown } from "../../ui/markdown/Markdown";
import { styles, useColors } from "../../ui/theme";
import { Button } from "../../ui/Button";
import { CopyAction } from "../viewers/copy-action";

/** Mounted on opening: markdown parsing and native views stay out of the timeline's chips. */
export function CitationViewer({
  quote,
  onClose,
  onSource,
}: {
  quote: ui.Quote;
  onClose: () => void;
  onSource: () => void;
}) {
  const c = useColors();
  const preview = citationPreview(quote);
  const url = safeHref(preview.url);

  return (
    <FullScreenViewer
      title="Citation"
      onClose={onClose}
      actions={<CopyAction text={preview.text} label="Copy quote" />}
    >
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {preview.markdown ? (
          <Markdown text={preview.text} />
        ) : (
          <Text selectable style={[styles.body, { color: c.text }]}>
            {preview.text}
          </Text>
        )}
        <Text selectable style={[styles.meta, { color: c.muted }]}>
          {preview.caption}
        </Text>
        {url ? (
          <View style={{ alignItems: "flex-start" }}>
            <Button title="Open on GitHub" size="sm" onPress={() => void Linking.openURL(url)} />
          </View>
        ) : quote.sourceItemId ? (
          <Button title="Jump to source" size="sm" onPress={onSource} />
        ) : null}
        {preview.comment ? (
          <Text selectable style={[styles.body, { color: c.text }]}>
            {preview.comment}
          </Text>
        ) : null}
      </ScrollView>
    </FullScreenViewer>
  );
}
