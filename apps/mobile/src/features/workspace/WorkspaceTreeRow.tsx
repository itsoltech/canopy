import { Pressable, Text } from "react-native";
import { ThreadDirectoryKind as Kind } from "@canopy/contracts";
import type { DirectoryRow, WorkspaceDirectory } from "@canopy/domain/workspace-directory";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function WorkspaceTreeRow({
  item,
  tree,
  selected,
  height,
  onOpen,
}: {
  item: DirectoryRow;
  tree: WorkspaceDirectory;
  selected: string | undefined;
  height: number;
  onOpen: (row: DirectoryRow) => void;
}) {
  const c = useColors();
  const entry = item.kind === "entry" ? item.entry : undefined;
  const node = item.kind === "entry" ? undefined : tree.node(item.directory);

  const disabled = entry
    ? entry.kind === Kind.SYMLINK || entry.kind === Kind.DELETED
    : Boolean(node?.read) || Boolean(node?.complete && !node.error);

  const status = entry?.gitStatus ?? "";

  const statusName =
    { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Conflict", "?": "Untracked", "!": "Ignored" }[
      status
    ] ?? "";

  const color =
    status === "D" || status === "U"
      ? c.danger
      : status === "M" || status === "R"
        ? c.warning
        : status === "A" || status === "?"
          ? c.success
          : status === "!"
            ? c.muted
            : c.text;

  const expanded = entry?.kind === Kind.DIRECTORY ? tree.expanded.has(entry.path) : undefined;

  const title =
    entry?.name ??
    (node?.read
      ? "Loading files…"
      : node?.error
        ? "Reload directory"
        : node?.complete
          ? "Empty directory"
          : "Load more");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        entry
          ? `${entry.path}${statusName ? `, ${statusName}` : ""}${entry.kind === Kind.SYMLINK ? ", Symbolic link" : ""}`
          : title
      }
      accessibilityState={{
        disabled,
        ...(expanded !== undefined && { expanded }),
        ...(entry && { selected: selected === entry.path }),
      }}
      disabled={disabled}
      onPress={() => onOpen(item)}
      style={({ pressed }) => ({
        height,
        paddingLeft: 16 + Math.min(item.depth, 12) * 16,
        paddingRight: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        backgroundColor: pressed ? c.pressed : c.surface,
      })}
    >
      <Icon
        name={
          entry?.kind === Kind.DIRECTORY
            ? expanded
              ? "chevron-down"
              : "chevron-right"
            : entry?.kind === Kind.SYMLINK
              ? "link"
              : entry
                ? "document-text"
                : "ellipsis-horizontal"
        }
      />
      <Text numberOfLines={1} style={[styles.body, { color, flex: 1 }]}>
        {title}
      </Text>
      {!!status && <Text style={[styles.meta, { color }]}>{status}</Text>}
    </Pressable>
  );
}
