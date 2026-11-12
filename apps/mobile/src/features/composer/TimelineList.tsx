import { useCallback, useEffect, useState, type ComponentProps, type Ref } from "react";
import { Platform, type FlatList, type FlatListProps, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useDerivedValue,
  useSharedValue,
  type ScrollHandlerProcessed,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ImageViewport, ImageViewportContext } from "../attachments/image-viewport";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";
import { useManualFeedAnchor } from "../../ui/feed-anchor";
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
  composerInset,
  ...props
}: Omit<ComponentProps<typeof Animated.FlatList<Item>>, "onScroll" | "onLayout" | "onContentSizeChange"> & {
  ref?: Ref<FlatList<Item>>;
  onScroll?: ScrollHandlerProcessed;
  onLayout?: FlatListProps<Item>["onLayout"];
  onContentSizeChange?: FlatListProps<Item>["onContentSizeChange"];
  composerInset?: SharedValue<number>;
}) {
  const insets = useContentInsets();
  const manualAnchor = useManualFeedAnchor();
  const safePadding = useDerivedValue(() => insets.bottom + (composerInset?.get() ?? 0));
  const [viewport] = useState(() => new ImageViewport());
  const lastCheck = useSharedValue(0);
  const refresh = viewport.refresh;

  useEffect(() => {
    if (!manualAnchor) refresh();
  }, [manualAnchor, refresh]);

  const imageScroll = useAnimatedScrollHandler({
    onScroll() {
      if (manualAnchor) return;
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
        <IOSChatScrollView {...scrollProps} composerInset={composerInset} />
      ) : (
        <KeyboardChatScrollView
          {...scrollProps}
          inverted
          offset={insets.bottom}
          extraContentPadding={safePadding}
          keyboardLiftBehavior={composerInset ? "whenAtEnd" : "always"}
        />
      ),
    [insets.bottom, safePadding, composerInset],
  );

  return (
    <ImageViewportContext.Provider value={viewport}>
      <Animated.FlatList
        {...props}
        nestedScrollEnabled
        maintainVisibleContentPosition={manualAnchor ? undefined : props.maintainVisibleContentPosition}
        onScroll={composedScroll}
        onLayout={(event) => {
          onLayout?.(event);
          refresh();
        }}
        onContentSizeChange={(width, height) => {
          onContentSizeChange?.(width, height);

          if (!manualAnchor) refresh();
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
