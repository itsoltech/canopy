import { useCallback, type ComponentProps, type Ref } from "react";
import { Platform, type FlatList, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import Animated, { useDerivedValue } from "react-native-reanimated";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";
import { IOSChatScrollView } from "./IOSChatScrollView";

/**
 * Inverted: the oldest end gets the floating header inset; the latest end has its composer reserve. A Reanimated
 * list, so scroll handlers (following, the composer's fold) run on the UI thread.
 */
export function TimelineList<Item>({
  contentContainerStyle,
  ...props
}: ComponentProps<typeof Animated.FlatList<Item>> & { ref?: Ref<FlatList<Item>> }) {
  const insets = useContentInsets();
  const safePadding = useDerivedValue(() => insets.bottom);

  const renderScrollComponent = useCallback(
    (scrollProps: ScrollViewProps) =>
      Platform.OS === "ios" ? (
        <IOSChatScrollView {...scrollProps} />
      ) : (
        <KeyboardChatScrollView
          {...scrollProps}
          inverted
          offset={insets.bottom}
          extraContentPadding={safePadding}
          keyboardLiftBehavior="always"
        />
      ),
    [insets.bottom, safePadding],
  );

  return (
    <Animated.FlatList
      {...props}
      renderScrollComponent={renderScrollComponent}
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
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
