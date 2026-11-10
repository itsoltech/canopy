import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { visibleCopyTree, toggleCopyNode, copySize, type CopyTreeNode } from "@canopy/domain/workspace-copy";
import { Field } from "./components";
import { Icon } from "./Icon";
import { useColors, useTypography } from "./theme";

/** A touch tree with one 48 dp row per visible node; virtualized inside the sheet's unscrolled body. */
export function FileTreePicker({
  roots,
  selected,
  onChange,
}: {
  roots: CopyTreeNode[];
  selected: ReadonlySet<string>;
  onChange: (value: Set<string>) => void;
}) {
  const [expanded, setExpanded] = useState(
    new Set(
      roots.some((node) => node.children.filter((child) => !child.children.length).length > 200) ? [] : ["ignored:"],
    ),
  );

  const [query, setQuery] = useState("");
  const rows = useMemo(() => visibleCopyTree(roots, expanded, query), [roots, expanded, query]);

  return (
    <View style={{ flex: 1, minHeight: 120, gap: 8 }}>
      <Field label="Filter files" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} />
      <FlatList
        data={rows}
        keyExtractor={(node) => node.key}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        extraData={selected}
        getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
        renderItem={({ item }) => (
          <TreeRow
            node={item}
            selected={selected}
            expanded={expanded.has(item.key)}
            onToggle={() => onChange(toggleCopyNode(selected, item))}
            onExpand={() => {
              const next = new Set(expanded);

              if (next.has(item.key)) next.delete(item.key);
              else next.add(item.key);
              setExpanded(next);
            }}
          />
        )}
      />
    </View>
  );
}

function TreeRow({
  node,
  selected,
  expanded,
  onToggle,
  onExpand,
}: {
  node: CopyTreeNode;
  selected: ReadonlySet<string>;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const count = node.members.reduce((sum, path) => sum + Number(selected.has(path)), 0);
  const checked = count > 0 && count === node.members.length;
  const mixed = count > 0 && !checked;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 48,
        paddingLeft: Math.min(node.depth, 5) * 12,
        gap: 6,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
        accessibilityState={{ expanded }}
        disabled={!node.children.length}
        onPress={onExpand}
        style={{
          width: 32,
          height: 48,
          alignItems: "center",
          justifyContent: "center",
          opacity: node.children.length ? 1 : 0,
        }}
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} color={c.muted} />
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`${node.path || node.label}, ${node.files} files, ${copySize(node.bytes)}`}
        accessibilityHint={node.blocked || (node.secret ? "May contain secrets" : undefined)}
        accessibilityState={{ checked: mixed ? "mixed" : checked, disabled: !node.members.length }}
        disabled={!node.members.length}
        onPress={onToggle}
        style={{ flex: 1, flexDirection: "row", minWidth: 0, height: 48, alignItems: "center", gap: 8 }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: checked || mixed ? c.brand : c.line,
            backgroundColor: checked || mixed ? c.brand : c.control,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {(checked || mixed) && <Icon name={mixed ? "minus" : "check"} size={14} color={c.onControl} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[type.body, { color: c.text }]}>
            {node.label}
            {node.children.length ? ` (${node.files})` : ""}
          </Text>
          {(node.secret || node.blocked) && (
            <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
              {node.blocked || "May contain secrets"}
            </Text>
          )}
        </View>
        <Text style={[type.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>{copySize(node.bytes)}</Text>
      </Pressable>
    </View>
  );
}
