import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkspaceCopyManifest } from "@canopy/contracts";
import { copyTree, copySelectable, copyRepositorySummary, copySkippedSummary } from "@canopy/domain/workspace-copy";
import { FileTreePicker } from "../../ui/FileTreePicker";
import { Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

export function WorkspaceCopyFiles({
  manifest,
  selected,
  onChange,
}: {
  manifest: WorkspaceCopyManifest;
  selected: ReadonlySet<string>;
  onChange: (value: Set<string>) => void;
}) {
  const c = useColors();
  const type = useTypography();
  const [showSkipped, setShowSkipped] = useState(false);
  const ignored = useMemo(() => manifest.entries.filter(copySelectable), [manifest]);
  const roots = useMemo(() => copyTree(ignored), [ignored]);

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      <Text style={[type.body, { color: c.text }]}>{copyRepositorySummary(manifest)}</Text>
      {!!manifest.skippedDirectories.length && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showSkipped }}
            onPress={() => setShowSkipped(!showSkipped)}
            style={{ minHeight: 48, justifyContent: "center" }}
          >
            <Text style={[type.meta, { color: c.muted }]}>{copySkippedSummary(manifest.skippedDirectories)}</Text>
          </Pressable>
          {showSkipped && <Text style={[type.meta, { color: c.muted }]}>{manifest.skippedDirectories.join(", ")}</Text>}
        </>
      )}
      {ignored.filter((e) => !e.directory).length > 200 && (
        <Notice>Many ignored files found. Check for dependencies or build output before selecting a directory.</Notice>
      )}
      {ignored.length ? (
        <FileTreePicker roots={roots} selected={selected} onChange={onChange} />
      ) : (
        <Notice>No ignored local files to choose</Notice>
      )}
    </View>
  );
}
