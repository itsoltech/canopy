import { HttpError } from "#lib/shared/http.ts";

export const mutationRefused = (cause: unknown) =>
  cause instanceof HttpError && [400, 401, 403, 404, 409, 412, 429].includes(cause.status);

/** Only the BFF's sanitized public RPC message is suitable for a refusal reason. */
export const mutationDetail = (cause: unknown) => (cause instanceof HttpError ? cause.message : "");
