import { isString } from "@canopy/domain/json";
import { CancellationError, HttpError } from "builder-util-runtime";
import { ReleaseHttpError } from "@canopy/domain/release/http";
import { UpdateTimeout } from "./update-operation.ts";
import type { Logger } from "electron-updater/out/types.js";

// Upstream errors can include response bodies, headers, file paths and signed URLs.
const knownCode =
  /\b(ENOENT|EACCES|EPERM|ENOSPC|EBUSY|ETIMEDOUT|ECONNRESET|ENOTFOUND|ERR_CHECKSUM_MISMATCH|ERR_UPDATER_INVALID_SIGNATURE|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED)\b/;

export function updateErrorCode(error?: Error) {
  if (error instanceof HttpError) return `HTTP ${error.statusCode}`;

  if (error instanceof ReleaseHttpError) return `HTTP ${error.status}`;

  if (error instanceof CancellationError) return "cancelled";

  if (!error) return "unknown";

  if (error instanceof UpdateTimeout) return "timeout";

  const code = "code" in error ? error.code : undefined;

  return (isString(code) && code.match(knownCode)?.[0]) || error.message.match(knownCode)?.[0] || "unknown";
}

export function updateLogger(write: (line: string) => void): Logger {
  return {
    info(message) {
      if (!isString(message)) return;

      if (message.startsWith("Downloading update from ")) write("download started");

      const launch = /^Cannot run installer: error code: ([^,]+),/.exec(message);

      if (launch) write(`installer launch failed code=${launch[1]?.match(knownCode)?.[0] ?? "unknown"}`);
    },
    warn(message) {
      if (isString(message) && message.startsWith("Could not clear the staged NSIS blockmap:"))
        write(`blockmap cleanup failed code=${message.match(knownCode)?.[0] ?? "unknown"}`);
    },
    error(message) {
      if (isString(message) && message.startsWith("Cannot download differentially, fallback to full download:"))
        write(`full download fallback code=${message.match(knownCode)?.[0] ?? "unknown"}`);
    },
  };
}
