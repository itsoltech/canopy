import { Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { useDevicePreferences } from "../settings/device-preferences";
import { Icon } from "../../ui/Icon";
import { PickerSheet } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { IconAction } from "./IconAction";
import { PageControls } from "./PageControls";
import type { usePages } from "./usePages";

export function CodeToolbar({
  commit,
  count,
  viewed,
  tree,
  onTree,
  onCommit,
}: {
  commit: string;
  count: string;
  viewed: string;
  tree: boolean;
  onTree: () => void;
  onCommit: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const { values, set } = useDevicePreferences();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        minHeight: 48,
        backgroundColor: c.background,
        borderBottomWidth: 1,
        borderColor: c.line,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Commit filter"
        onPress={onCommit}
        style={{ flexDirection: "row", alignItems: "center", gap: 3, minHeight: 44, maxWidth: 95 }}
      >
        <Text numberOfLines={1} style={[type.meta, { color: c.text }]}>
          {commit ? commit.slice(0, 7) : "All"}
        </Text>
        <Icon name="chevron-down" size={12} />
      </Pressable>
      <Text
        accessibilityLabel={`${count} files. Viewed applies to the whole pull request.`}
        style={[type.meta, { flex: 1, color: c.muted }]}
      >
        {viewed} viewed
      </Text>
      <IconAction
        icon={values.diffLayout === "split" ? "view-columns" : "square-2-stack"}
        label={values.diffLayout === "split" ? "Side by side · switch to stacked" : "Stacked · switch to side by side"}
        selected={values.diffLayout === "split"}
        onPress={() => set("diffLayout", values.diffLayout === "split" ? "stacked" : "split")}
      />
      <IconAction
        icon="text-wrap"
        label="Wrap"
        selected={values.wrapDiffs === "on"}
        onPress={() => set("wrapDiffs", values.wrapDiffs === "on" ? "off" : "on")}
      />
      <IconAction
        icon="space"
        label="Hide whitespace"
        selected={values.hideWhitespace === "on"}
        onPress={() => set("hideWhitespace", values.hideWhitespace === "on" ? "off" : "on")}
      />
      <IconAction icon="file-tree" label="File tree" selected={tree} onPress={onTree} />
    </View>
  );
}

export function CommitFilter({
  open,
  value,
  pages,
  onClose,
  onSelect,
}: {
  open: boolean;
  value: string;
  pages: ReturnType<typeof usePages<github.PullRequestCommitsPage>>;
  onClose: () => void;
  onSelect: (sha: string) => void;
}) {
  return (
    <PickerSheet
      title="Commit filter"
      visible={open}
      value={value}
      search="Search commits"
      onClose={onClose}
      onSelect={onSelect}
      sections={[
        {
          options: [
            { value: "", label: "All commits" },
            ...pages.pages.flatMap((p) =>
              p.commits.map((item) => ({ value: item.sha, label: `${item.sha.slice(0, 7)} ${item.subject}` })),
            ),
          ],
        },
      ]}
      footer={
        <PageControls
          page={pages.current?.page}
          busy={pages.busy}
          error={pages.error}
          next={() => void pages.read(true)}
          retry={() => void pages.read(false, true)}
        />
      }
    />
  );
}
