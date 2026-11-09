import { ActivityIndicator, Pressable } from "react-native";
import { useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";

/** The preferred delivery and its alternative while a turn runs, or send/stop when idle/empty. */
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
  const queues = running && primary === "queue";
  const label = queues ? "Queue message" : "Steer message";

  return (
    <>
      {alternate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={queues ? "Steer message" : "Queue message"}
          onPress={alternate}
          disabled={unavailable}
          style={{ padding: 8, opacity: unavailable ? 0.4 : 1 }}
        >
          <Icon name={queues ? "arrow-up" : "queue-list"} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stop ? "Stop the turn" : running ? label : "Send message"}
        accessibilityHint={alternate ? `Hold to ${queues ? "steer" : "queue"} this message.` : undefined}
        disabled={unavailable}
        onPress={onSend}
        onLongPress={stop ? undefined : alternate}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: disabled || unavailable ? c.line : stop ? c.text : c.accent,
        }}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c.onAccent} />
        ) : (
          <Icon
            name={stop ? "stop" : queues ? "queue-list" : "arrow-up"}
            color={unavailable ? c.faint : stop ? c.background : c.onAccent}
            size={18}
          />
        )}
      </Pressable>
    </>
  );
}
