import { useEffect, useState } from "react";
import { Animated, View } from "react-native";
import type { AgentMessage } from "@canopy/contracts";
import { Markdown } from "../../ui/markdown";
import { useReducedMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";

/** Agent text as markdown; commentary (thinking aloud while working) is quieter than answers (web: AgentMessageView). */
export function AgentMessageView({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  const c = useColors();
  const commentary = message.phase === "commentary";

  return (
    <View
      accessibilityState={{ busy: streaming }}
      style={commentary ? { borderLeftWidth: 2, borderColor: c.rule, paddingLeft: 12 } : undefined}
    >
      <Markdown text={message.text} color={commentary ? c.muted : undefined} />
      {streaming && <Caret />}
    </View>
  );
}

/** The breathing caret after streaming text; still under reduced motion. */
function Caret() {
  const c = useColors();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduced) return;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );

    loop.start();

    return () => loop.stop();
  }, [opacity, reduced]);

  return (
    <Animated.View
      accessible={false}
      style={{ marginTop: 4, width: 6, height: 16, borderRadius: 2, backgroundColor: c.faint, opacity }}
    />
  );
}
