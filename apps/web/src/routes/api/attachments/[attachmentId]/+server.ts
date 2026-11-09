import { attachmentResponse } from "#lib/server/attachment-response.ts";
import { gateway } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

/** An attachment's bytes (`?thumbnail` = an image's WebP thumbnail, `?download` = always as a download); owner only. */
export const GET: RequestHandler = ({ params, url }) => attachmentResponse(gateway(), params.attachmentId, url);
