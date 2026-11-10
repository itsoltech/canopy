import { useEffect, useState } from "react";
import { Animated, Pressable } from "react-native";
import type { AgentMessage } from "@canopy/contracts";
import { Markdown } from "../../ui/markdown";
import { useReducedMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { useMessageActions } from "./useMessageActions";

/** Agent prose stays primary reading content, inside work folds and in the answer slot (web: AgentMessageView). */
export function AgentMessageView({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  const actions = useMessageActions(message.text, "agent_message", !streaming);

  return (
    <>
      <Pressable {...actions.trigger} accessibilityState={{ busy: streaming }}>
        <Markdown text={message.text} selectable={!actions.available} />
        {streaming && <Caret />}
      </Pressable>
      {actions.menu}
    </>
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
