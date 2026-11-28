import { useCallback, useEffect, useState, type ReactElement, type Ref } from "react";
import { Platform, FlatList, View, type FlatListProps, type ScrollViewProps } from "react-native";
import {
  KeyboardChatScrollView,
  useKeyboardContext,
  type KeyboardChatScrollViewRef,
} from "react-native-keyboard-controller";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useComposedEventHandler,
  useDerivedValue,
  useSharedValue,
  type ScrollHandlerProcessed,
  type SharedValue,
  type AnimatedProps,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ImageViewport, ImageViewportContext } from "../attachments/image-viewport";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";
import { useManualFeedAnchor } from "../../ui/feed-anchor";
import { IOSChatScrollView } from "./IOSChatScrollView";
import { keyboardLift, useKeyboardFrame } from "../../ui/KeyboardWindow";

const android = Platform.OS === "android";

/** Keep the newest row beside the composer throughout IME motion. Both use the current keyboard frame. */
function AndroidThreadReserve({ bottom, composerInset }: { bottom: number; composerInset: SharedValue<number> }) {
  const keyboard = useKeyboardFrame();
  const style = useAnimatedStyle(() => ({ height: bottom + keyboardLift(keyboard, bottom) + composerInset.get() }));

  return <Animated.View pointerEvents="none" style={style} />;
}

/** Bot chats lift even while reading older messages. The native scroller already supplies its own IME inset. */
function AndroidBotScroll(props: ScrollViewProps & { ref?: Ref<KeyboardChatScrollViewRef> }) {
  const { bottom } = useContentInsets();
  const keyboard = useKeyboardFrame();
  const native = useKeyboardContext().reanimated;
  const correction = useDerivedValue(() => keyboardLift(keyboard, bottom) - keyboardLift(native, bottom));

  return <KeyboardChatScrollView {...props} inverted offset={bottom} extraContentPadding={correction} />;
}

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
  followingEnd,
  disclosureAddsRows = false,
  ListHeaderComponent,
  ...props
}: Omit<AnimatedProps<FlatListProps<Item>>, "onScroll" | "onLayout" | "onContentSizeChange" | "ListHeaderComponent"> & {
  ref?: Ref<FlatList<Item>>;
  onScroll?: ScrollHandlerProcessed;
  onLayout?: FlatListProps<Item>["onLayout"];
  onContentSizeChange?: FlatListProps<Item>["onContentSizeChange"];
  composerInset?: SharedValue<number>;
  /** A following Android thread keeps offset zero as its keyboard reserve grows and shrinks. */
  followingEnd?: boolean;
  /** A bot disclosure inserts list rows; a thread disclosure resizes its existing cell. */
  disclosureAddsRows?: boolean;
  /** Under the latest row (inverted). */
  ListHeaderComponent?: ReactElement;
}) {
  const insets = useContentInsets();
  // Reanimated's convenience FlatList replaces CellRendererComponent. Use its base wrapper so the
  // thread can measure actual cells, while keeping the component identity stable for this list's lifetime.
  const [AnimatedTimelineList] = useState(() => Animated.createAnimatedComponent(FlatList<Item>));
  const manualAnchor = useManualFeedAnchor();
  // Android also shifts its first visible row when an inverted list prepends entries. Let the tapped
  // header own that scroll until expansion settles; ordinary arrivals still use native anchoring.
  const manualPosition = android && disclosureAddsRows ? undefined : { minIndexForVisible: 0 };
  // FlatList skips the header when picking its anchor. Pinning the first message would counteract
  // the growing reserve and leave the message behind the composer until the next scroll correction.
  const readingPosition = android && followingEnd ? undefined : props.maintainVisibleContentPosition;

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

  const renderChatScroll = useCallback(
    (scrollProps: ScrollViewProps) =>
      android ? (
        <AndroidBotScroll {...scrollProps} />
      ) : (
        <IOSChatScrollView {...scrollProps} composerInset={composerInset} />
      ),
    [composerInset],
  );

  return (
    <ImageViewportContext.Provider value={viewport}>
      <AnimatedTimelineList
        {...props}
        ListHeaderComponent={
          android ? (
            <>
              {ListHeaderComponent}
              {composerInset ? (
                <AndroidThreadReserve bottom={insets.bottom} composerInset={composerInset} />
              ) : (
                <View style={{ height: insets.bottom }} />
              )}
            </>
          ) : (
            ListHeaderComponent
          )
        }
        nestedScrollEnabled
        // Android clipping detaches native WebViews inside inverted cells, even while React retains the row.
        // FlatList still virtualizes/unmounts distant turns; this only disables native view detachment.
        removeClippedSubviews={false}
        maintainVisibleContentPosition={manualAnchor ? manualPosition : readingPosition}
        onScroll={composedScroll}
        onLayout={(event) => {
          onLayout?.(event);
          refresh();
        }}
        onContentSizeChange={(width, height) => {
          onContentSizeChange?.(width, height);

          if (!manualAnchor) refresh();
        }}
        renderScrollComponent={android && composerInset ? undefined : renderChatScroll}
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
