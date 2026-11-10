import { useEffect, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";

/** An explicit, transient read; unsafe or unavailable origins leave the field empty and editable. */
export function useWorkspaceSource(project: ui.Project) {
  const { client } = useSession();
  const [url, setUrl] = useState("");
  const touched = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      for (const workspace of project.workspaces) {
        try {
          const response = await client?.api.getWorkspaceCloneSource({ workspaceId: workspace.id });

          if (active && response?.cloneUrl) {
            if (!touched.current) setUrl(response.cloneUrl);

            return;
          }
        } catch {
          /* Try another workspace; the user can enter a URL. */
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [client, project]);

  return {
    url,
    setUrl: (value: string) => {
      touched.current = true;
      setUrl(value);
    },
  };
}
