import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import type { WorkspaceCopyManifest } from "@canopy/contracts";
import { copyTree, copySelectable, copyRepositorySummary, copySkippedSummary } from "@canopy/domain/workspace-copy";
import { FileTreePicker } from "../../ui/FileTreePicker";
import { Notice } from "../../ui/components";
import { Chevron, Expand } from "../../ui/MotionViews";
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
  const repository = copyRepositorySummary(manifest);

  return (
    <FileTreePicker
      roots={roots}
      selected={selected}
      onChange={onChange}
      header={
        <View style={{ gap: 12 }}>
          <View style={{ gap: 4 }}>
            <Text style={[type.body, { color: c.text }]}>{repository.overview}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Branch: ${repository.branch}`}
              onPress={() => Alert.alert("Branch", repository.branch)}
            >
              <Text
                selectable
                numberOfLines={1}
                style={[type.meta, { fontFamily: type.mono.fontFamily, color: c.text }]}
              >
                {repository.branch}
              </Text>
            </Pressable>
            <Text style={[type.meta, { color: c.muted }]}>{repository.changes}</Text>
          </View>
          {!!manifest.skippedDirectories.length && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showSkipped }}
                onPress={() => setShowSkipped(!showSkipped)}
                style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Chevron open={showSkipped} color={c.muted} />
                <Text style={[type.meta, { flex: 1, color: c.muted }]}>
                  {copySkippedSummary(manifest.skippedDirectories)}
                </Text>
              </Pressable>
              <Expand open={showSkipped}>
                <ScrollView style={{ maxHeight: 112 }} nestedScrollEnabled>
                  {manifest.skippedDirectories.map((path) => (
                    <Text key={path} style={[type.meta, { color: c.muted }]}>
                      {path}
                    </Text>
                  ))}
                </ScrollView>
              </Expand>
            </>
          )}
          {ignored.filter((e) => !e.directory).length > 200 && (
            <Notice>
              Many ignored files found. Check for dependencies or build output before selecting a directory.
            </Notice>
          )}
          {!ignored.length && <Notice>No ignored local files to choose</Notice>}
        </View>
      }
    />
  );
}
