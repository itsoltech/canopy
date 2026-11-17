import { View } from "react-native";
import { useFollowingList } from "../../ui/useFollowingList";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { composerGeometry, threadComposerHeight } from "../composer/geometry";
import { ComposerBox } from "../threads/ComposerBox";
import type { ThreadCreation } from "./thread-creations";
import { ThreadPreparationTimeline } from "./ThreadPreparationTimeline";

const idle = () => {};

/** The regular input shell reserves its complete expanded height before the thread exists. */
export function PreparationConversation({ job }: { job: ThreadCreation }) {
  const following = useFollowingList<ThreadCreation>(true, threadComposerHeight);
  const composer = useFloatingComposer(following, false, threadComposerHeight);

  return (
    <ChatKeyboard composerHeight={composer.height}>
      <ThreadPreparationTimeline job={job} inset={following.composerInset} />
      <FloatingComposer
        motion={composer.motion}
        coverage={following.composerInset}
        onLayout={composer.measure}
        onExpand={idle}
      >
        <View style={{ gap: 8 }}>
          <ComposerBox text="" onChange={idle} onSend={idle} readonly disabled triggers />
          <View style={{ height: composerGeometry.secondary }} />
        </View>
      </FloatingComposer>
    </ChatKeyboard>
  );
}
