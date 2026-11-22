import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { PickerSheet } from "../../ui/Picker";
import { font, styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";

/** The split Steer / Queue button's width; the toolbar keeps this room beside it. */
export const SPLIT_SEND_WIDTH = 124;

/**
 * Send, or stop when a running turn's field is empty (web: ComposerBox). While a turn runs and there is a message,
 * the split button of the web (SteerSendButton): its main part does the preferred way, steer into the running turn
 * or queue for the next one (holding it does the other), and the chevron offers both with what each does.
 */
export function SendButtons({
  alternate,
  primary,
  onSend,
  stop,
  running,
  disabled,
  busy,
  unavailable,
}: {
  alternate?: () => void;
  primary: "steer" | "queue";
  onSend?: () => void;
  stop: boolean;
  running: boolean;
  disabled?: boolean;
  busy?: boolean;
  unavailable: boolean;
}) {
  const c = useColors();

  if (running && alternate && onSend)
    return (
      <SplitSend primary={primary} onSend={onSend} onAlternate={alternate} busy={busy} unavailable={unavailable} />
    );

  const queue = running && !stop && primary === "queue";
  const ink = unavailable ? c.faint : stop ? c.background : c.onAccent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={stop ? "Stop the turn" : queue ? "Queue for the next turn" : "Send message"}
      accessibilityState={{ busy: busy && !stop, disabled: unavailable }}
      disabled={unavailable}
      onPress={onSend}
      style={({ pressed }) => ({
        width: queue ? undefined : 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        paddingHorizontal: queue ? 12 : undefined,
        gap: 6,
        backgroundColor: disabled || unavailable ? c.line : stop ? c.text : pressed ? c.actionPressed : c.action,
      })}
    >
      {busy && !stop ? (
        <ActivityIndicator size="small" color={c.muted} />
      ) : (
        <Icon name={stop ? "stop" : queue ? "queue-list" : "arrow-up"} color={ink} size={queue ? 16 : 18} />
      )}
      {queue && (
        <Text numberOfLines={1} style={[styles.meta, { fontFamily: font.medium, color: ink }]}>
          Queue
        </Text>
      )}
    </Pressable>
  );
}

function SplitSend({
  primary,
  onSend,
  onAlternate,
  busy,
  unavailable,
}: {
  primary: "steer" | "queue";
  onSend: () => void;
  onAlternate: () => void;
  busy?: boolean;
  unavailable: boolean;
}) {
  const c = useColors();
  const [menu, setMenu] = useState(false);
  const steerFirst = primary === "steer";
  const ink = unavailable ? c.faint : c.onAccent;

  const half = (pressed: boolean) => ({
    height: 36,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: unavailable ? c.line : pressed ? c.actionPressed : c.action,
  });

  return (
    <View style={[styles.row, { minWidth: SPLIT_SEND_WIDTH, gap: 0, borderRadius: 18, overflow: "hidden" }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={steerFirst ? "Steer into the running turn" : "Queue for the next turn"}
        accessibilityState={{ busy, disabled: unavailable }}
        accessibilityHint={`Hold to ${steerFirst ? "queue it for the next turn" : "steer it into the running turn"}.`}
        disabled={unavailable}
        onPress={onSend}
        onLongPress={onAlternate}
        style={({ pressed }) => [half(pressed), { flex: 1, gap: 6, paddingLeft: 12, paddingRight: 8 }]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={ink} style={{ width: 16, height: 16 }} />
        ) : (
          <Icon name={steerFirst ? "arrow-up" : "queue-list"} color={ink} />
        )}
        <Text numberOfLines={1} style={[styles.meta, { fontFamily: font.medium, color: ink }]}>
          {steerFirst ? "Steer" : "Queue"}
        </Text>
      </Pressable>
      <View style={{ width: 1, height: 36, backgroundColor: unavailable ? c.line : c.action }}>
        <View style={{ marginTop: 10, height: 16, backgroundColor: `${c.onAccent}4d` }} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More ways to send"
        disabled={unavailable}
        onPress={() => setMenu(true)}
        style={({ pressed }) => [half(pressed), { paddingLeft: 8, paddingRight: 12 }]}
      >
        <Icon name="chevron-down" size={14} color={ink} />
      </Pressable>
      <PickerSheet
        title="How to send"
        visible={menu}
        onClose={() => setMenu(false)}
        onSelect={(way) => (way === primary ? onSend : onAlternate)()}
        sections={[
          {
            options: [
              {
                value: "steer" as const,
                label: "Steer into this turn",
                description: "Joins the turn the agent is working on now.",
                icon: "arrow-turn-down-right",
              },
              {
                value: "queue" as const,
                label: "Queue for the next turn",
                description: "Waits and runs as the next turn.",
                icon: "queue-list",
              },
            ],
          },
        ]}
      />
    </View>
  );
}
