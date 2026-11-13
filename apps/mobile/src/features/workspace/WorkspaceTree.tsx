import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { ThreadDirectoryKind as Kind } from "@canopy/contracts";
import { workspaceDirectories, type DirectoryRow } from "@canopy/domain/workspace-directory";
import type { Workspace } from "@canopy/domain/workspace";
import { Button, IconButton, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { WorkspaceTreeRow } from "./WorkspaceTreeRow";

export function WorkspaceTree({ view, onOpen = () => {} }: { view: Workspace; onOpen?: () => void }) {
  const c = useColors();
  const { fontScale, height } = useWindowDimensions();
  const tree = useMemo(() => workspaceDirectories(view.store, 1024 * 1024).tree(view.threadId), [view]);
  useSyncExternalStore(tree.subscribe, tree.getVersion);
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  useEffect(() => tree.retain(), [tree]);
  const rows = tree.rows();
  const rowHeight = Math.max(48, Math.ceil(20 * fontScale + 16));
  const error = [...tree.nodes.values()].find((node) => node.error)?.error;
  const root = tree.node("");

  function open(row: DirectoryRow) {
    if (row.kind !== "entry") {
      void tree.load(row.directory, row.kind === "state");

      return;
    }

    if (row.entry.kind === Kind.DIRECTORY) tree.toggle(row.entry.path);
    else if (row.entry.kind === Kind.FILE) {
      view.open({ threadId: view.threadId, path: row.entry.path });
      onOpen();
    }
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingHorizontal: 12, gap: 4 }}>
        <Text style={[styles.meta, { color: c.muted, flex: 1 }]}>Working directory</Text>
        <IconButton icon="arrow-path" label="Reload files" onPress={() => tree.invalidate()} />
        <Button
          title={tree.includeIgnored ? "Hide ignored files" : "Show ignored files"}
          onPress={() => tree.showIgnored(!tree.includeIgnored)}
        />
      </View>
      {!!root.status && <Text style={[styles.meta, { color: c.muted, paddingHorizontal: 16 }]}>{root.status}</Text>}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => (
          <WorkspaceTreeRow
            item={item}
            tree={tree}
            selected={view.currentFile?.document.path}
            height={rowHeight}
            onOpen={open}
          />
        )}
        extraData={tree.getVersion()}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={Math.max(1, Math.min(3, Math.floor(78 / Math.ceil(height / rowHeight))))}
        getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="never"
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
      {!!error && (
        <View style={{ padding: 16 }}>
          <Notice>{error}</Notice>
        </View>
      )}
    </View>
  );
}
