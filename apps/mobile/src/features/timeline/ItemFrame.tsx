import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Pressable, View, type HostInstance } from "react-native";
import { ItemStatus } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { ItemStatusIcon } from "./ItemStatusIcon";
import { Chevron } from "../../ui/MotionViews";
import { activityHeader, activitySurface } from "./activity-header";

/** The nested items of the item a frame shows (web: item-context.ts); a frame shows them inside its details. */
export const ItemChildren = createContext<ReactNode>(undefined);

/**
 * One-line activity row (tool, command, file change …) that opens to its details (web: ItemFrame). It always starts
 * closed; only the reader opens it. Set in the work context (docs/ui-scale.md): a step under the messages around it.
 * `nested`: the items under it (a subagent's work), shown inside its details behind a rail.
 */
export function ItemFrame({
  icon,
  lead,
  status,
  tone = "neutral",
  title,
  aside,
  children,
  nested,
  label,
}: {
  icon: IconName;
  lead?: ReactNode;
  status: ItemStatus;
  tone?: "neutral" | "violet" | "rose";
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  nested?: ReactNode;
  /** What a screen reader says for the row. */
  label?: string;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const inherited = useContext(ItemChildren);
  nested ??= inherited;
  const header = useRef<HostInstance>(null);
  const toggle = useAnchoredToggle();
  const violet = useTone("violet").dot;
  const rose = useTone("rose").dot;

  const iconColor = tone === "violet" ? violet : tone === "rose" || status === ItemStatus.FAILED ? rose : c.icon;
  const body = Boolean(children || nested);

  // The disclosure chevron leads an expandable row (web: Disclosure); a row without details keeps its place empty.
  const row = (
    <View style={[styles.row, { alignItems: "flex-start", minHeight: 24 }]}>
      {body && (
        <View style={{ height: 24, justifyContent: "center" }}>
          <Chevron open={open} color={c.faint} />
        </View>
      )}
      <View style={{ height: 24, justifyContent: "center" }}>{lead ?? <Icon name={icon} color={iconColor} />}</View>
      <View style={{ flex: 1, minWidth: 0, minHeight: 24, justifyContent: "center" }}>{title}</View>
      <View style={[styles.row, { flexShrink: 0, minHeight: 24 }]}>
        {aside}
        <ItemStatusIcon status={status} />
      </View>
    </View>
  );

  if (!body) return <View style={[activityHeader.row, activitySurface(c), { paddingLeft: 32 }]}>{row}</View>;

  return (
    <View>
      <View ref={header} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(header.current, () => setOpen(!open))}
          style={({ pressed }) => [
            activityHeader.row,
            activitySurface(c),
            { justifyContent: "center" },
            pressed && { backgroundColor: c.pressed },
          ]}
        >
          {row}
        </Pressable>
      </View>
      {open && (
        <View style={{ marginTop: 4, marginBottom: 8, gap: 8, paddingLeft: 24 }}>
          {children}
          {nested && <View style={{ gap: 4, borderLeftWidth: 2, borderColor: c.rule, paddingLeft: 12 }}>{nested}</View>}
        </View>
      )}
    </View>
  );
}
