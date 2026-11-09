import { useEffect, useState } from "react";
import { useSession } from "../../state/session";
import { imageCacheKey, ImageReadError, readImage, type ImageSource } from "./image-source";
import { attachmentFailure } from "./failure";
import { useAttachmentConnection } from "./useAttachmentConnection";

/** The pairing owns private immutable files. A mounted image retains only its file URI. */
export function useImage(source: ImageSource, thumbnail = false, enabled = true) {
  const { client, imageCache } = useSession();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ uri: string; error: string }>({ uri: "", error: "" });
  const local = source.kind === "local" ? source.uri : "";
  const threadId = source.kind === "thread" ? source.threadId : "";
  const sha256 = source.kind === "thread" ? source.sha256 : "";
  const sizeBytes = source.kind === "thread" ? source.sizeBytes : 0n;
  const file = source.kind === "attachment" ? source.file : undefined;
  const connection = useAttachmentConnection(file?.id ?? threadId);

  useEffect(() => {
    const controller = new AbortController();
    setResult({ uri: local, error: "" });

    if (!local && client && imageCache && enabled) {
      const remote: Exclude<ImageSource, { kind: "local" }> = file
        ? { kind: "attachment", file }
        : { kind: "thread", threadId, sha256, sizeBytes };

      void imageCache
        .get(
          imageCacheKey(remote, thumbnail),
          async (signal) => (await readImage(client.api, remote, thumbnail, signal)).data,
          controller.signal,
        )
        .then((uri) => {
          if (!controller.signal.aborted) setResult({ uri, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({
              uri: "",
              error:
                error instanceof ImageReadError
                  ? error.message
                  : attachmentFailure(error, "Could not load the image. Check the connection, then retry."),
            });
        });
    }

    return () => controller.abort();
  }, [client, imageCache, local, threadId, sha256, sizeBytes, file, thumbnail, retry, enabled, connection]);

  return {
    ...result,
    retry: () => {
      const cleared =
        source.kind === "local" || !imageCache
          ? Promise.resolve()
          : imageCache.invalidate(imageCacheKey(source, thumbnail));

      void cleared
        .then(() => setRetry((n) => n + 1))
        .catch(() => setResult({ uri: "", error: "Could not load the image. Check the connection, then retry." }));
    },
  };
}
