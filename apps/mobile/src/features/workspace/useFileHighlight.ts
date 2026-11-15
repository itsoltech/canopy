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

  const [stored, setStored] = useState<{ version: string; tokens: ReadonlyMap<number, SyntaxLine> }>({
    version: "",
    tokens: new Map(),
  });

  const [note, setNote] = useState("");
  const file = document.file;
  const version = highlightKey(document, 0, draft !== undefined);
  const key = highlightKey(document, start, draft !== undefined);
  const cached = client && enabled && active ? cachedHighlight(client, key) : undefined;
  const tokens = new Map(stored.version === version ? stored.tokens : []);

  if (cached) for (const line of cached.lines) tokens.set(line.line, line);

  useEffect(() => {
    setNote("");

    if (!enabled || !active || !client || !file?.sha256) return;
    const controller = new AbortController();
    const revision = draft === undefined ? "" : String(++serial.current);

    const fetchWindow = async (line: number) => {
      const windowKey = highlightKey(document, line, draft !== undefined);
      const saved = cachedHighlight(client, windowKey);

      const result =
        saved ??
        (await client.api.getThreadFileHighlight(
          {
            threadId: document.target.threadId,
            path: file.relativePath || document.path,
            sha256: file.sha256,
            startLine: line,
            lineCount: 200,
            ...(draft !== undefined && { draft, draftRevision: revision }),
          },
          { signal: controller.signal, timeoutMs: 15_000 },
        ));

      if (
        controller.signal.aborted ||
        document.file !== file ||
        result.sha256 !== file.sha256 ||
        (!saved && result.draftRevision !== revision)
      )
        return;
      rememberHighlight(client, windowKey, result);
      setStored((previous) => {
        const next = new Map(previous.version === version ? previous.tokens : []);

        for (const item of result.lines) next.set(item.line, item);

        // Keep native JS memory bounded; the session LRU still serves earlier windows immediately.
        while (next.size > 1000) {
          const oldest = next.keys().next().value;

          if (oldest === undefined) break;
          next.delete(oldest);
        }

        return { version, tokens: next };
      });
      setNote(result.reason);
    };

    void fetchWindow(start)
      .then(() => {
        if (!controller.signal.aborted) return fetchWindow(start + 80);
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
  }, [client, document, file, start, active, enabled, draft, version]);

  return { tokens, note };
}
