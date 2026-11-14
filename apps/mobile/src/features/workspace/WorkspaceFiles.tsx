import { WorkspaceTree } from "./WorkspaceTree";
import { useWorkspace } from "./context";
import { Sheet } from "../../ui/components";

/** The thread's Files: the directory tree in a sheet. Picking a file opens it as a tab and closes the sheet. */
export function WorkspaceFiles({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const view = useWorkspace();

  if (!view) return null;

  return (
    <Sheet title="Files" visible={visible} onClose={onClose} scroll={false}>
      {visible && <WorkspaceTree view={view} onOpen={onClose} />}
    </Sheet>
  );
}
