import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "../../state/session";
import { imageCacheKey, ImageReadError, readImage, type ImageSource } from "./image-source";
import { attachmentFailure } from "./failure";
import { useAttachmentConnection } from "./useAttachmentConnection";

/** The pairing owns private immutable files. A mounted image retains only its file URI. */
export function useImage(source: ImageSource, thumbnail = false, enabled = true) {
  const { client, imageCache } = useSession();
  const [retry, setRetry] = useState(0);
  const key = source.kind === "local" ? source.uri : imageCacheKey(source, thumbnail);
  const currentSource = useRef(source);
  useLayoutEffect(() => {
    currentSource.current = source;
  }, [source]);
  const cached = () => (source.kind === "local" ? source.uri : (imageCache?.peek(key) ?? ""));
  const [result, setResult] = useState(() => ({ key, cache: imageCache, uri: cached(), error: "" }));
  const local = source.kind === "local" ? source.uri : "";
  const threadId = source.kind === "thread" ? source.threadId : "";
  const file = source.kind === "attachment" ? source.file : undefined;
  const connection = useAttachmentConnection(file?.id ?? threadId);

  useEffect(() => {
    const controller = new AbortController();
    const remote = currentSource.current;

    if (remote.kind !== "local" && client && imageCache && enabled) {
      void imageCache
        .get(key, async (signal) => (await readImage(client.api, remote, thumbnail, signal)).data, controller.signal)
        .then((uri) => {
          if (!controller.signal.aborted) setResult({ key, cache: imageCache, uri, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({
              key,
              cache: imageCache,
              uri: "",
              error:
                error instanceof ImageReadError
                  ? error.message
                  : attachmentFailure(error, "Could not load the image. Check the connection, then retry."),
            });
        });
    }

    return () => controller.abort();
  }, [client, imageCache, local, key, thumbnail, retry, enabled, connection]);

  return {
    ...(result.key === key && result.cache === imageCache ? result : { uri: cached(), error: "" }),
    retry: () => {
      const cleared =
        source.kind === "local" || !imageCache
          ? Promise.resolve()
          : imageCache.invalidate(imageCacheKey(source, thumbnail));

      void cleared
        .then(() => {
          setResult({ key, cache: imageCache, uri: "", error: "" });
          setRetry((n) => n + 1);
        })
        .catch(() =>
          setResult({
            key,
            cache: imageCache,
            uri: "",
            error: "Could not load the image. Check the connection, then retry.",
          }),
        );
    },
  };
}
