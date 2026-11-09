import type { ComponentType } from "react";
import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Token, Tokens } from "marked";
import { isToken } from "@canopy/domain/markdown";
import { useColors, useTypography } from "../theme";
import { Inline } from "./Inline";
import { useMarkdownScope } from "./scope";

/** A task item's box, checked or not, read-only (web: ChoiceControl, disabled). */
function TaskBox({ checked }: { checked: boolean }) {
  const c = useColors();

  return (
    <View
      accessible
      accessibilityRole="checkbox"
      accessibilityLabel={checked ? "Done" : "Not done"}
      accessibilityState={{ checked, disabled: true }}
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: checked ? c.action : c.faint,
        backgroundColor: checked ? c.action : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.7,
      }}
    >
      {checked && (
        <Svg width={17} height={17} viewBox="0 0 14 14" fill="none">
          <Path
            d="M3 8L6 11L11 3.5"
            stroke={c.onControl}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      )}
    </View>
  );
}

/** Renders block tokens; passed in by `Blocks`, which renders lists (no import cycle). */
type BlocksView = ComponentType<{ tokens: readonly Token[] }>;

/** A tight item's text runs inline; everything else (and every part of a loose item) is a block. */
function ItemBody({ item, Blocks }: { item: Tokens.ListItem; Blocks: BlocksView }) {
  const type = useTypography();
  const { ink, selectable } = useMarkdownScope();

  if (item.loose) return <Blocks tokens={item.tokens} />;

  return item.tokens.map((child, index) =>
    isToken(child, "text") ? (
      <Text key={index} selectable={selectable} style={[type.body, { color: ink }]}>
        {child.tokens ? <Inline tokens={child.tokens} /> : child.text}
      </Text>
    ) : (
      <Blocks key={index} tokens={[child]} />
    ),
  );
}

/** An ordered, bulleted or task list (web: MarkdownBlocks list); nested lists indent under their item. */
export function MarkdownList({ list, Blocks }: { list: Tokens.List; Blocks: BlocksView }) {
  const c = useColors();
  const type = useTypography();
  const start = list.start === "" ? 1 : list.start;

  return (
    <View style={{ gap: 4 }}>
      {list.items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", gap: 8 }}>
          {item.task ? (
            <View style={{ height: type.body.lineHeight, justifyContent: "center" }}>
              <TaskBox checked={!!item.checked} />
            </View>
          ) : (
            <Text style={[type.body, { minWidth: 16, textAlign: "right", color: c.faint }]}>
              {list.ordered ? `${start + index}.` : "•"}
            </Text>
          )}
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 8 }}>
            <ItemBody item={item} Blocks={Blocks} />
          </View>
        </View>
      ))}
    </View>
  );
}
