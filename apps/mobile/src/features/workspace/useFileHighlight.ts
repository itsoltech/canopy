import { useEffect, useRef, useState } from "react";
import type { SyntaxLine } from "@canopy/contracts";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { ConnectError, Code } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { cachedHighlight, highlightKey, rememberHighlight } from "./highlight-cache";

/** One token window, aborted in background. Draft bytes require explicit preview. */
export function useFileHighlight(document: WorkspaceFile, start: number, enabled: boolean, draft?: string) {
  const { client } = useSession();
  const active = useAppActive();
  const serial = useRef(0);
  const [tokens, setTokens] = useState<ReadonlyMap<number, SyntaxLine>>(new Map());
  const [note, setNote] = useState("");
  const file = document.file;

  useEffect(() => {
    setTokens(new Map());
    setNote("");

    if (!enabled || !active || !client || !file?.sha256) return;
    const key = highlightKey(document, start, draft !== undefined);
    const cached = cachedHighlight(client, key);

    if (cached) {
      setTokens(new Map(cached.lines.map((line) => [line.line, line])));
      setNote(cached.reason);

      return;
    }

    const controller = new AbortController();
    const revision = draft === undefined ? "" : String(++serial.current);
    void client.api
      .getThreadFileHighlight(
        {
          threadId: document.target.threadId,
          path: file.relativePath || document.path,
          sha256: file.sha256,
          startLine: start,
          lineCount: 200,
          ...(draft !== undefined && { draft, draftRevision: revision }),
        },
        { signal: controller.signal, timeoutMs: 15_000 },
      )
      .then((result) => {
        if (controller.signal.aborted || result.sha256 !== file.sha256 || result.draftRevision !== revision) return;
        rememberHighlight(client, key, result);
        setTokens(new Map(result.lines.map((line) => [line.line, line])));
        setNote(result.reason);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = ConnectError.from(cause);
        setNote(
          error.code === Code.Unimplemented
            ? "Update Canopy on the thread’s computer to highlight files."
            : "Highlighting is unavailable. The file remains readable.",
        );
      });

    return () => controller.abort();
  }, [client, document, file, start, active, enabled, draft]);

  return { tokens, note };
}
