import { useEffect, useState } from "react";
import { Animated, Pressable } from "react-native";
import type { AgentMessage } from "@canopy/contracts";
import { Markdown } from "../../ui/markdown";
import { useReducedMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { useMessageActions } from "./useMessageActions";
import { useAppActive } from "../../ui/active";
import { useViewportVisibility } from "../../ui/viewport";
import { ThreadFileLinks } from "../files/ThreadFileLinks";

/** Agent prose stays primary reading content, inside work folds and in the answer slot (web: AgentMessageView). */
export function AgentMessageView({
  message,
  streaming,
  itemId,
}: {
  message: AgentMessage;
  streaming: boolean;
  itemId: string;
}) {
  const actions = useMessageActions(message.text, "agent_message", !streaming);

  return (
    <ThreadFileLinks itemId={itemId}>
      <Pressable {...actions.trigger} accessibilityState={{ busy: streaming }}>
        <Markdown text={message.text} selectable={!actions.available} />
        {streaming && <Caret />}
      </Pressable>
      {actions.menu}
    </ThreadFileLinks>
  );
}

/** The breathing caret after streaming text; still under reduced motion. */
function Caret() {
  const c = useColors();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  const viewport = useViewportVisibility();
  const active = useAppActive() && viewport.visible;

  useEffect(() => {
    if (reduced || !active) {
      opacity.setValue(1);

      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true, isInteraction: false }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true, isInteraction: false }),
      ]),
    );

    loop.start();

    return () => loop.stop();
  }, [opacity, reduced, active]);

  return (
    <Animated.View
      ref={viewport.ref}
      onLayout={viewport.onLayout}
      collapsable={false}
      accessible={false}
      style={{ marginTop: 4, width: 6, height: 16, borderRadius: 2, backgroundColor: c.faint, opacity }}
    />
  );
}
