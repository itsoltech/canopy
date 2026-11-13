import { ScrollView, View } from "react-native";
import type { WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
import type { ThreadState } from "../threads/ThreadScreen";
import { ThreadConnectors } from "../threads/ThreadConnectors";
import { ThreadBackgroundTasks } from "../threads/ThreadBackgroundTasks";
import { ThreadSchedules } from "../threads/ThreadPanel";
import { useThreadPanel } from "../threads/use-thread-panel";
import { ThreadPullRequests } from "../github/ThreadPullRequests";
import { PullRequestScreen } from "../github/PullRequestScreen";
import { Notice } from "../../ui/components";
import { useContentPadding } from "../../ui/ScreenFrame";
import { WorkspaceTask } from "./WorkspaceTask";

export function WorkspaceModule({ state, target }: { state: ThreadState; target: WorkspaceModuleTarget }) {
  const padding = useContentPadding();

  if (target.module === "pull-requests" && target.resource)
    return <PullRequestScreen id={target.resource} threadId={state.thread?.id} embedded />;

  if (target.module === "tasks" && target.resource) return <WorkspaceTask state={state} id={target.resource} />;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={padding}>
      <WorkspaceModuleBody state={state} target={target} onClose={() => undefined} />
    </ScrollView>
  );
}

export function WorkspaceModuleBody({
  state,
  target,
  onClose,
}: {
  state: ThreadState;
  target: WorkspaceModuleTarget;
  onClose: () => void;
}) {
  const { thread, snapshot, home } = state;
  const panel = useThreadPanel(thread?.id ?? "", Boolean(thread) && target.module !== "pull-requests");
  const stale = home.away || !!panel.data?.stale || !!panel.error || state.stream.connection !== "live";

  if (!thread) return <Notice>Opening the thread…</Notice>;

  if (target.module === "pull-requests") return <ThreadPullRequests thread={thread} onClose={onClose} />;

  if (target.module === "connectors")
    return <ThreadConnectors thread={thread} panel={panel} disabled={stale} homeName={home.name} />;

  return (
    <View style={{ gap: 16 }}>
      {stale && <Notice>Showing last known tasks. Reconnect to manage them.</Notice>}
      {snapshot && (
        <>
          <ThreadBackgroundTasks snapshot={snapshot} disabled={stale} onOpen={onClose} />
          <ThreadSchedules
            snapshot={snapshot}
            schedules={
              thread.nodeId || stale || !snapshot.schedules.length
                ? (panel.data?.schedules ?? snapshot.schedules)
                : snapshot.schedules
            }
            unavailable={!!panel.data?.unavailable}
            disabled={stale}
            onClose={onClose}
          />
        </>
      )}
    </View>
  );
}
