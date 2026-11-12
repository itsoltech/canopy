import { useState, type ReactNode } from "react";
import { FileLinks } from "../../ui/markdown/file-links";
import { useTimelineDirectory } from "../timeline/directory";
import { ThreadFileViewer } from "./ThreadFileViewer";

/** A message's item id gives its home gateway the correct turn for path hints. */
export function ThreadFileLinks({ itemId, children }: { itemId: string; children: ReactNode }) {
  const { currentId } = useTimelineDirectory();
  const [path, setPath] = useState("");

  return (
    <FileLinks.Provider value={currentId ? setPath : undefined}>
      {children}
      {path && (
        <ThreadFileViewer key={path} threadId={currentId} itemId={itemId} path={path} onClose={() => setPath("")} />
      )}
    </FileLinks.Provider>
  );
}
