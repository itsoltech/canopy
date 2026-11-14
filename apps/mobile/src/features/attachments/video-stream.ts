import { NativeModule, requireNativeModule } from "expo";
import { readVideoRequest, type VideoApi, type VideoRequest } from "./video-read";

declare class MediaModule extends NativeModule<{ onRequest: (request: VideoRequest) => void }> {
  open(): Promise<{ id: string; url: string }>;
  write(
    serverId: string,
    requestId: string,
    status: number,
    headers: Record<string, string>,
    data: Uint8Array,
    end: boolean,
  ): Promise<void>;
  close(id: string): void;
}

const media = requireNativeModule<MediaModule>("CanopyMediaStream");

class PlayerReadClosed extends Error {}

/** A viewer-only random loopback capability. Neither credentials nor gateway addresses reach the player. */
export async function openVideoStream(api: VideoApi, attachmentId: string, signal: AbortSignal, onError: () => void) {
  const server = await media.open();
  const abort = new AbortController();

  const close = () => {
    abort.abort();
    media.close(server.id);
    subscription.remove();
    signal.removeEventListener("abort", close);
  };

  const subscription = media.addListener("onRequest", (request) => {
    if (request.serverId !== server.id || abort.signal.aborted) return;
    void readVideoRequest(
      api,
      attachmentId,
      request,
      (status, headers, data, end) =>
        media.write(server.id, request.requestId, status, headers, data, end).catch(() => {
          throw new PlayerReadClosed();
        }),
      abort.signal,
    ).catch(async (cause) => {
      // Seeking cancels the previous native request; that is not a playback/network failure.
      if (cause instanceof PlayerReadClosed) return;

      if (!abort.signal.aborted) {
        // Native error strings never expose capability URLs, pairing addresses or tokens.
        await media
          .write(server.id, request.requestId, 503, { "Content-Length": "0" }, new Uint8Array(), true)
          .catch(() => {});
        onError();
      }
    });
  });

  signal.addEventListener("abort", close, { once: true });

  if (signal.aborted) {
    close();
    throw new Error("Video stream closed");
  }

  return { uri: server.url, close };
}
