import type { ComponentProps, Ref } from "react";
import type { FlatList } from "react-native";
import Animated from "react-native-reanimated";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";

/**
 * Inverted: the oldest end gets the floating header inset; the latest end has its composer reserve. A Reanimated
 * list, so scroll handlers (following, the composer's fold) run on the UI thread.
 */
export function TimelineList<Item>({
  contentContainerStyle,
  ...props
}: ComponentProps<typeof Animated.FlatList<Item>> & { ref?: Ref<FlatList<Item>> }) {
  const insets = useContentInsets();

  return (
    <Animated.FlatList
      {...props}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={[
        styles.page,
        contentContainerStyle,
        { paddingBottom: 16 + insets.top, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right },
      ]}
    />
  );
}
