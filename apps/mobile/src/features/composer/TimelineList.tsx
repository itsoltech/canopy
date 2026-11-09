import { useCallback, useState, type ComponentProps, type Ref } from "react";
import { Platform, type FlatList, type FlatListProps, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useDerivedValue,
  useSharedValue,
  type ScrollHandlerProcessed,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ImageViewport, ImageViewportContext } from "../attachments/image-viewport";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";
import { IOSChatScrollView } from "./IOSChatScrollView";

/**
 * Inverted: the oldest end gets the floating header inset; the latest end has its composer reserve. A Reanimated
 * list, so scroll handlers (following, the composer's fold) run on the UI thread.
 */
export function TimelineList<Item>({
  contentContainerStyle,
  onScroll,
  onLayout,
  onContentSizeChange,
  ...props
}: Omit<ComponentProps<typeof Animated.FlatList<Item>>, "onScroll" | "onLayout" | "onContentSizeChange"> & {
  ref?: Ref<FlatList<Item>>;
  onScroll?: ScrollHandlerProcessed;
  onLayout?: FlatListProps<Item>["onLayout"];
  onContentSizeChange?: FlatListProps<Item>["onContentSizeChange"];
}) {
  const insets = useContentInsets();
  const safePadding = useDerivedValue(() => insets.bottom);
  const [viewport] = useState(() => new ImageViewport());
  const lastCheck = useSharedValue(0);
  const refresh = viewport.refresh;

  const imageScroll = useAnimatedScrollHandler({
    onScroll() {
      const now = Date.now();

      if (now - lastCheck.get() < 100) return;
      lastCheck.set(now);
      scheduleOnRN(refresh);
    },
    onMomentumEnd() {
      scheduleOnRN(refresh);
    },
    onEndDrag() {
      scheduleOnRN(refresh);
    },
  });

  const composedScroll = useComposedEventHandler([onScroll ?? null, imageScroll]);

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
    <ImageViewportContext.Provider value={viewport}>
      <Animated.FlatList
        {...props}
        onScroll={composedScroll}
        onLayout={(event) => {
          onLayout?.(event);
          refresh();
        }}
        onContentSizeChange={(width, height) => {
          onContentSizeChange?.(width, height);
          refresh();
        }}
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
    </ImageViewportContext.Provider>
  );
}
