import { useEffect, useState } from "react";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { useSession } from "../../state/session";
import { ImageReadError, readImage, type ImageSource } from "./image-source";

/** Private bytes stay in this mounted view; they never enter an image URL, log or shared cache. */
export function useImage(source: ImageSource, thumbnail = false) {
  const { client } = useSession();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ uri: string; error: string }>({ uri: "", error: "" });
  const local = source.kind === "local" ? source.uri : "";
  const threadId = source.kind === "thread" ? source.threadId : "";
  const sha256 = source.kind === "thread" ? source.sha256 : "";
  const sizeBytes = source.kind === "thread" ? source.sizeBytes : 0n;
  const file = source.kind === "attachment" ? source.file : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setResult({ uri: local, error: "" });

    if (!local && client) {
      const remote: Exclude<ImageSource, { kind: "local" }> = file
        ? { kind: "attachment", file }
        : { kind: "thread", threadId, sha256, sizeBytes };

      void readImage(client.api, remote, thumbnail, controller.signal)
        .then((image) => {
          if (!controller.signal.aborted)
            setResult({ uri: `data:${image.mimeType};base64,${base64Encode(image.data)}`, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({
              uri: "",
              error:
                error instanceof ImageReadError
                  ? error.message
                  : "Could not load the image. Check the connection, then retry.",
            });
        });
    }

    return () => controller.abort();
  }, [client, local, threadId, sha256, sizeBytes, file, thumbnail, retry]);

  return { ...result, retry: () => setRetry((n) => n + 1) };
}
