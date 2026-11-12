import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { attachmentFailure } from "../attachments/failure";

export const EDIT_BYTES = 400 * 1024;

/** Mutations require the resolved path and the hash of the displayed bytes. Failed saves keep the draft. */
export function useFileMutation(
  threadId: string,
  file: ui.ThreadFile | undefined,
  onSaved: (file: ui.ThreadFile) => void,
) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function mutate(draft?: string): Promise<boolean> {
    if (!client || !file?.sha256 || busy) return false;
    setBusy(true);
    setError("");
    const remove = draft === undefined;

    try {
      const target = { threadId, path: file.path, expectedSha256: file.sha256 };

      if (remove) await client.api.deleteThreadFile(target, { timeoutMs: 40_000 });
      else {
        const content = new TextEncoder().encode(draft);

        if (content.length > EDIT_BYTES) throw new Error("The edited file exceeds the save limit");
        const saved = await client.api.writeThreadFile({ ...target, content }, { timeoutMs: 40_000 });
        onSaved({ ...file, ...saved, content, relativePath: file.relativePath, computer: file.computer });
      }

      return true;
    } catch (cause) {
      setError(
        attachmentFailure(
          cause,
          remove
            ? "Could not delete the file. Reload, then retry."
            : "Could not save the file. Check the file size and connection, then retry.",
        ),
      );

      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, clearError: () => setError(""), mutate };
}
