import { error, isHttpError, type RequestHandler } from "@sveltejs/kit";
import { Code, ConnectError } from "@connectrpc/connect";
import { failWith, gateway } from "./gateway.ts";
import { FILE_TRANSFER_UPDATE, threadFileStream } from "./thread-file-stream.ts";

export function threadFileHandler(mode: "video" | "download"): RequestHandler<{ threadId: string }> {
  return async ({ params, url, request, setHeaders }) => {
    setHeaders({ "cache-control": "private, no-store" });
    const path = url.searchParams.get("path") ?? "";
    const itemId = url.searchParams.get("itemId") ?? "";

    if (!path.trim() || path.length > 4096 || itemId.length > 1024)
      error(400, "This file path is invalid. Check the path, then retry.");

    try {
      const check = mode === "download" && url.searchParams.get("check") === "1";

      return await threadFileStream(
        gateway(),
        { threadId: params.threadId, path, itemId },
        request,
        check ? "check" : mode,
      );
    } catch (cause) {
      if (request.signal.aborted) return new Response(null, { status: 499 });

      if (isHttpError(cause)) throw cause;

      if (cause instanceof ConnectError) {
        if (cause.code === Code.Unimplemented) error(426, FILE_TRANSFER_UPDATE);

        if (cause.code === Code.DeadlineExceeded)
          error(504, "The file took too long to open. Check the connection, then retry.");
      }

      failWith(cause);
    }
  };
}
