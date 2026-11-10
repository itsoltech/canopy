import { useEffect, useState } from "react";
import { Animated, View } from "react-native";
import type { AgentMessage } from "@canopy/contracts";
import { Markdown } from "../../ui/markdown";
import { useReducedMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { CopyAction } from "../viewers/copy-action";
import { QuoteAction } from "../quotes/QuoteAction";

/** Agent prose stays primary reading content, inside work folds and in the answer slot (web: AgentMessageView). */
export function AgentMessageView({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  return (
    <View accessibilityState={{ busy: streaming }}>
      <Markdown text={message.text} />
      {streaming && <Caret />}
      {!streaming && message.text.trim() ? (
        <View style={{ flexDirection: "row", gap: 8, minHeight: 32 }}>
          <CopyAction text={message.text} label="Copy message" />
          <QuoteAction text={message.text} kind="agent_message" />
        </View>
      ) : null}
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
