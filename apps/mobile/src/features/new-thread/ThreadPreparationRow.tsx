import { useState } from "react";
import { View, type ViewProps } from "react-native";
import { router } from "expo-router";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { TurnDay } from "../timeline/TurnStart";
import { UserMessageView } from "../timeline/UserMessageView";
import { ThreadPreparation } from "./ThreadPreparation";
import type { ThreadCreation } from "./thread-creations";

/** Accept FlatList's inversion style and keep its empty row's layout separate from the viewport. */
export function ThreadPreparationRow({ job, style }: Pick<ViewProps, "style"> & { job: ThreadCreation }) {
  const [date] = useState(() => new Date());

  return (
    <View collapsable={false} style={[{ gap: 12 }, style]}>
      <View style={{ marginBottom: -8, minHeight: 20 }}>
        <TurnDay date={date} />
      </View>
      <UserMessageView
        pending
        text={job.request.initialMessage}
        attachments={job.attachments}
        mentions={job.request.initialMentions}
        quotes={job.request.initialQuotes}
      />
    </View>
  );
}

/** Render below the prompt in a separate cell so progress changes don't resize the prompt's native anchor. */
export function ThreadPreparationProgress({ job }: { job: ThreadCreation }) {
  return (
    <View style={{ gap: 16, paddingTop: 16, paddingBottom: 12 }}>
      <ThreadPreparation job={job} staging />
      <PreparationRecovery job={job} />
    </View>
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
