import { View } from "react-native";
import { useFollowingList } from "../../ui/useFollowingList";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { FloatingComposer } from "../composer/FloatingComposer";
import { TimelineList } from "../composer/TimelineList";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { compactThreadComposerHeight } from "../composer/geometry";
import { ComposerBox } from "../threads/ComposerBox";
import type { ThreadCreation } from "./thread-creations";
import { ThreadPreparationProgress, ThreadPreparationRow } from "./ThreadPreparationRow";
import { usePreparationAnchor } from "./usePreparationAnchor";
import { useThreadTimelineStyle } from "../threads/timeline-layout";

const idle = () => {};

/** The preparation uses the same one-row input shell as a thread with an empty draft. */
export function PreparationConversation({ job }: { job: ThreadCreation }) {
  const following = useFollowingList<ThreadCreation>(true, compactThreadComposerHeight);
  const composer = useFloatingComposer(following, false, compactThreadComposerHeight, false);
  const anchor = usePreparationAnchor(job, following, following.listProps.onScroll);
  const content = useThreadTimelineStyle(true, composer.height);

  return (
    <ChatKeyboard composerHeight={composer.height}>
      <TimelineList
        {...following.listProps}
        composerInset={following.composerInset}
        followingEnd={following.atBottom}
        onScroll={anchor.onScroll}
        onLayout={anchor.onLayout}
        onContentSizeChange={anchor.onContentSizeChange}
        style={{ flex: 1 }}
        contentContainerStyle={content}
        data={[]}
        maintainVisibleContentPosition={anchor.maintainVisibleContentPosition}
        ListHeaderComponent={<ThreadPreparationProgress job={job} />}
        ListEmptyComponent={<ThreadPreparationRow job={job} />}
        ListFooterComponent={<View style={{ paddingBottom: 16 }} />}
      />
      <FloatingComposer
        motion={composer.motion}
        coverage={following.composerInset}
        resizeInset
        onLayout={composer.measure}
        onExpand={idle}
        onLatest={
          following.atBottom
            ? undefined
            : () => {
                job.preparationAnchor = undefined;
                composer.showLatest();
              }
        }
      >
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ComposerBox text="" onChange={idle} onSend={idle} compact readonly disabled triggers />
        </View>
      </FloatingComposer>
    </ChatKeyboard>
  );
}
