import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import type { SharedValue } from "react-native-reanimated";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { useFollowingList } from "../../ui/useFollowingList";
import { TimelineList } from "../composer/TimelineList";
import { threadComposerHeight } from "../composer/geometry";
import { TurnDay } from "../timeline/TurnStart";
import { UserMessageView } from "../timeline/UserMessageView";
import { useThreadTimelineStyle } from "../threads/timeline-layout";
import { ThreadPreparation } from "./ThreadPreparation";
import type { ThreadCreation } from "./thread-creations";
import { usePreparationAnchor } from "./usePreparationAnchor";

/** A local preparation is a row in the real chat scroller, without manufacturing a Thread or Turn. */
export function ThreadPreparationTimeline({ job, inset }: { job: ThreadCreation; inset: SharedValue<number> }) {
  const following = useFollowingList<ThreadCreation>(true, threadComposerHeight);
  const content = useThreadTimelineStyle(true);
  const [date] = useState(() => new Date());
  const anchor = usePreparationAnchor(job, following);

  return (
    <TimelineList
      {...following.listProps}
      composerInset={inset}
      onScroll={anchor.onScroll}
      onLayout={anchor.measure}
      onContentSizeChange={anchor.measure}
      style={{ flex: 1 }}
      contentContainerStyle={content}
      data={[job]}
      keyExtractor={(item) => item.id}
      ListFooterComponent={<View style={{ paddingBottom: 16 }} />}
      renderItem={() => (
        <View style={{ gap: 12, paddingBottom: 12 }}>
          <View style={{ marginBottom: -8, minHeight: 20 }}>
            <TurnDay date={date} />
          </View>
          <View ref={anchor.prompt} collapsable={false} onLayout={anchor.measure} style={{ gap: 16 }}>
            <UserMessageView
              pending
              text={job.request.initialMessage}
              attachments={job.attachments}
              mentions={job.request.initialMentions}
              quotes={job.request.initialQuotes}
            />
            <ThreadPreparation job={job} />
            <PreparationRecovery job={job} />
          </View>
        </View>
      )}
    />
  );
}

function PreparationRecovery({ job }: { job: ThreadCreation }) {
  const { threadCreations } = useSession();
  const confirmedWithoutId = job.confirmed && !job.threadId;

  if (!job.error && !job.uncertain && !confirmedWithoutId) return null;

  return (
    <View style={{ gap: 12 }}>
      <Notice error={Boolean(job.error) && !job.uncertain && !job.confirmed}>
        {job.error || "Thread creation is not confirmed. Open the draft to check its status."}
      </Notice>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          title={confirmedWithoutId ? "Open threads" : "Return to draft"}
          onPress={() =>
            confirmedWithoutId
              ? router.replace("/")
              : router.replace({
                  pathname: "/new-thread",
                  params: { project: job.request.projectId, workspace: job.request.workspaceId },
                })
          }
        />
        {job.uncertain && job.done && <Button title="Check delivery" onPress={() => threadCreations?.start(job.id)} />}
      </View>
    </View>
  );
}
