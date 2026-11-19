import { useCallback, useEffect, useState, type ReactElement, type Ref } from "react";
import { Platform, FlatList, type FlatListProps, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView, useKeyboardContext } from "react-native-keyboard-controller";
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
import { useKeyboardFrame } from "../../ui/KeyboardWindow";

const android = Platform.OS === "android";

/** The composer reserve laid out under the latest row (an inverted list's header is its visual bottom). */
function Reserve({ height }: { height: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ height: height.get() }));

  return <Animated.View pointerEvents="none" style={style} />;
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
  disclosureAddsRows = false,
  ListHeaderComponent,
  ...props
}: Omit<AnimatedProps<FlatListProps<Item>>, "onScroll" | "onLayout" | "onContentSizeChange" | "ListHeaderComponent"> & {
  ref?: Ref<FlatList<Item>>;
  onScroll?: ScrollHandlerProcessed;
  onLayout?: FlatListProps<Item>["onLayout"];
  onContentSizeChange?: FlatListProps<Item>["onContentSizeChange"];
  composerInset?: SharedValue<number>;
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
  const keyboard = useKeyboardFrame();
  const nativeKeyboard = useKeyboardContext().reanimated;

  const reserve = useDerivedValue(() => insets.bottom + (composerInset?.get() ?? 0));

  // Android's chat scroller shows its inset by translating the content natively. React's layout does not see that
  // offset, so a press in a row cancels on the slightest finger movement, and each inset change scrolls the list by
  // its delta. The reserve is a row there instead (`Reserve`); the native inset carries only the keyboard.
  const safePadding = useDerivedValue(() => {
    if (!android) return reserve.get();

    // The chat scroller already adds its native keyboard inset. Only reconcile the difference from
    // Android's settled bounds, so a missed frame stream cannot leave the latest message under the IME.
    const settled = Math.max(0, -keyboard.height.get() - insets.bottom * keyboard.progress.get());
    const native = Math.max(0, -nativeKeyboard.height.get() - insets.bottom * nativeKeyboard.progress.get());

    return settled - native;
  });

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
      <AnimatedTimelineList
        {...props}
        ListHeaderComponent={
          android ? (
            <>
              {ListHeaderComponent}
              <Reserve height={reserve} />
            </>
          ) : (
            ListHeaderComponent
          )
        }
        nestedScrollEnabled
        // Android clipping detaches native WebViews inside inverted cells, even while React retains the row.
        // FlatList still virtualizes/unmounts distant turns; this only disables native view detachment.
        removeClippedSubviews={false}
        maintainVisibleContentPosition={manualAnchor ? manualPosition : props.maintainVisibleContentPosition}
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
