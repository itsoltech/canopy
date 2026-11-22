import { useEffect, useLayoutEffect } from "react";
import { Redirect, router, useIsFocused, usePathname } from "expo-router";
import { useSession } from "../../state/session";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { Button, EmptyState } from "../../ui/components";
import { useOverview } from "../../state/overview";
import { useColors } from "../../ui/theme";
import { ThreadHeaderBar } from "../threads/ThreadHeaderBar";
import { PreparationConversation } from "./PreparationConversation";
import { useThreadCreation } from "./useThreadCreation";

const idle = () => {};

export function ThreadStartingScreen({ id }: { id: string }) {
  const { session, threadCreations } = useSession();
  const focused = useIsFocused();
  const pathname = usePathname();
  const job = useThreadCreation(id);
  const { projects } = useOverview();
  const c = useColors();
  const threadId = job?.threadId;

  useLayoutEffect(() => {
    threadCreations?.restore(id);
  }, [id, threadCreations]);

  useEffect(() => {
    if (session && focused && pathname === `/thread-starting/${id}` && threadId)
      router.replace({ pathname: "/thread/[id]", params: { id: threadId, preparation: "1" } });
  }, [session, focused, pathname, id, threadId]);

  if (!session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame
      headerBackgroundColor={c.sidebar}
      header={
        <ThreadHeaderBar
          project={projects.find((project) => project.id === job?.request.projectId)}
          preparingTitle="New thread"
          syncing={false}
          onActions={idle}
          onSearch={idle}
          onDetails={idle}
          onFiles={idle}
          onPreview={idle}
        />
      }
    >
      {job ? (
        <PreparationConversation job={job} />
      ) : (
        <ScreenScroll>
          <EmptyState
            title="Thread preparation unavailable"
            description="Open a new thread to recover a saved draft."
            action={<Button title="Open new thread" onPress={() => router.replace("/new-thread")} />}
          />
        </ScreenScroll>
      )}
    </ScreenFrame>
  );
}
