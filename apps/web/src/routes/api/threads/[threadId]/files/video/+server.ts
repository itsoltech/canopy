import { threadFileHandler } from "#lib/server/thread-file-handler.ts";

export const GET = threadFileHandler("video");
export const HEAD = GET;
