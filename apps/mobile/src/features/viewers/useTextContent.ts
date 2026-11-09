import { useEffect, useMemo, useState } from "react";
import type { BlobRef } from "@canopy/contracts";
import { useSession } from "../../state/session";

const TEXT_BYTES = 8 * 1024 ** 2;

export function useTextContent(text: string, blob: BlobRef | undefined, threadId: string) {
  const { client } = useSession();
  const [loaded, setLoaded] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const inlineTooLarge = useMemo(
    () =>
      text.length > TEXT_BYTES || (text.length > TEXT_BYTES / 3 && new TextEncoder().encode(text).length > TEXT_BYTES),
    [text],
  );

  const tooLarge = blob ? blob.sizeBytes > BigInt(TEXT_BYTES) : inlineTooLarge;
  const sha256 = blob?.sha256;

  useEffect(() => {
    if (tooLarge) return;
    const controller = new AbortController();
    setError("");

    if (!sha256) setLoaded(text);
    else if (client) {
      setLoaded(undefined);
      void client.api
        .getThreadBlob({ threadId, sha256 }, { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;

          if (response.data.length > TEXT_BYTES) {
            setError("This content exceeds the 8 MB viewing limit. Ask the agent for a smaller section.");

            return;
          }

          setLoaded(new TextDecoder("utf-8", { fatal: true }).decode(response.data));
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("Could not load this content. Check the connection, then retry.");
        });
    }

    return () => controller.abort();
  }, [client, threadId, sha256, text, tooLarge, attempt]);

  return { loaded, error, tooLarge, retry: () => setAttempt((n) => n + 1) };
}
