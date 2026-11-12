import { Text, View } from "react-native";
import { SheetDragArea, SheetCloseButton } from "../../ui/SheetDragArea";
import { Segmented } from "../../ui/Segmented";
import { styles, useColors } from "../../ui/theme";
import { PullRequestPickerAccount } from "./PullRequestPickerAccount";
import type { usePullRequestPicker } from "./usePullRequestPicker";

export function PullRequestPickerHeader({ picker: p }: { picker: ReturnType<typeof usePullRequestPicker> }) {
  const c = useColors();

  return (
    <SheetDragArea
      style={{
        paddingHorizontal: 12,
        paddingTop: 4,
        paddingBottom: 4,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[styles.overlayHeading, { color: c.muted, minWidth: 0, flex: 1 }]}
      >
        {p.data?.repositoryName || "Pull requests"}
      </Text>
      {p.data?.selection && p.data.selection.candidates.length > 1 && (
        <PullRequestPickerAccount
          selection={p.data.selection}
          disabled={p.busy || p.loading}
          onchoose={(id) => void p.choose(id)}
        />
      )}
      <View style={{ width: 96 }}>
        <Segmented
          compact
          value={p.filter}
          onChange={p.setFilter}
          options={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
          ]}
        />
      </View>
      <SheetCloseButton label="Close picker" />
    </SheetDragArea>
  );
}
