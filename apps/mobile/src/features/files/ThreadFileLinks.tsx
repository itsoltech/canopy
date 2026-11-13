import type { ReactNode } from "react";
import { router } from "expo-router";
import { FileLinks } from "../../ui/markdown/file-links";
import { useTimelineDirectory } from "../timeline/directory";
import { useWorkspace } from "../workspace/context";
import { useSession } from "../../state/session";

/** A message's item id gives its home gateway the correct turn for path hints. */
export function ThreadFileLinks({ itemId, children }: { itemId: string; children: ReactNode }) {
  const { currentId } = useTimelineDirectory();
  const { workspace: store } = useSession();
  const workspace = useWorkspace();

  return (
    <FileLinks.Provider
      value={
        currentId
          ? (path) => {
              (workspace ?? store.view(currentId)).open({ threadId: currentId, itemId, path });

              if (!workspace) router.push({ pathname: "/threads/[id]", params: { id: currentId } });
            }
          : undefined
      }
    >
      {children}
    </FileLinks.Provider>
  );
}
