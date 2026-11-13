import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { CopyAction } from "../viewers/copy-action";
import { WorkspaceText } from "./WorkspaceText";

export function WorkspaceConflict({
  document,
  onDiscard,
  children,
}: {
  document: WorkspaceFile;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const [compare, setCompare] = useState<"disk" | "draft">();
  useEffect(() => {
    if (!document.changedOnDisk) setCompare(undefined);
  }, [document.changedOnDisk]);

  return (
    <>
      {!!document.watchStatus && (
        <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>{document.watchStatus}</Text>
      )}
      {document.changedOnDisk && (
        <View style={{ padding: 12, gap: 8 }}>
          <Text accessibilityLiveRegion="polite" style={[styles.body, { color: c.muted }]}>
            {document.removedOnDisk ? "Removed from disk" : "Changed on disk"}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {document.diskText !== undefined && document.dirty && (
              <Button
                title={compare ? "Keep editing" : "Compare changes"}
                size="sm"
                onPress={() => setCompare(compare ? undefined : "disk")}
              />
            )}
            {document.dirty && <CopyAction text={document.draft} label="Copy changes" />}
            <Button title="Discard and reload" size="sm" disabled={document.busy} onPress={onDiscard} />
          </View>
        </View>
      )}
      {compare ? (
        <>
          <View style={{ flexDirection: "row", gap: 8, padding: 12 }}>
            <Button title="On disk" size="sm" onPress={() => setCompare("disk")} />
            <Button title="Your changes" size="sm" onPress={() => setCompare("draft")} />
          </View>
          <WorkspaceText
            document={document}
            draft={compare === "disk" ? (document.diskText ?? "") : document.draft}
            plain
          />
        </>
      ) : (
        children
      )}
    </>
  );
}
