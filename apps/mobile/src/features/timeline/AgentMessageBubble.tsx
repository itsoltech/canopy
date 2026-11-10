import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import { firstLine } from "@canopy/domain/first-line";
import { Icon } from "../../ui/Icon";
import { styles, useTypography } from "../../ui/theme";
import { useTone } from "../../ui/tone";

/**
 * The violet bubble of a message one agent sent another (a steer, a task, a message, a report) (web:
 * AgentMessageBubble). A long message folds to its first line with a chevron; a tap opens the whole message
 * (`children`) and folds it again. `rich`: it carries more than its text (quotes), so it always folds.
 */
export function AgentMessageBubble({
  text,
  rich = false,
  label = "Show the whole message",
  dim = false,
  children,
  actions,
}: {
  text: string;
  rich?: boolean;
  label?: string;
  dim?: boolean;
  children: ReactNode;
  actions?: PressableProps;
}) {
  const type = useTypography();
  const violet = useTone("violet");
  const [expanded, setExpanded] = useState(false);
  const line = firstLine(text);
  const folds = rich || line.more || line.text.length > 60;

  return (
    <Pressable
      {...actions}
      // Folded, tapping opens the message; open, only the chevron folds it. Long press works in either state.
      disabled={!actions?.onLongPress && (!folds || expanded)}
      onPress={folds && !expanded ? () => setExpanded(true) : undefined}
      accessibilityRole={folds && !expanded ? "button" : undefined}
      accessibilityLabel={folds && !expanded ? `${label}: ${line.text}` : actions?.accessibilityLabel}
      style={{
        maxWidth: "85%",
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 16,
        borderBottomRightRadius: 6,
        borderWidth: 1,
        borderColor: violet.panel.ring,
        backgroundColor: violet.panel.background,
        opacity: dim ? 0.7 : 1,
      }}
    >
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        {folds && !expanded ? (
          <Text numberOfLines={1} style={[type.body, { color: violet.panel.text }]}>
            {line.text}
          </Text>
        ) : (
          children
        )}
      </View>
      {folds && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show less" : label}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          hitSlop={12}
          style={[styles.row, { height: 24, alignSelf: "flex-start" }]}
        >
          <View style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}>
            <Icon name="chevron-down" color={`${violet.dot}99`} />
          </View>
        </Pressable>
      )}
    </Pressable>
  );
}
