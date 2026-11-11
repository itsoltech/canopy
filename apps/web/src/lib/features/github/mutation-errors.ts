import { HttpError } from "#lib/shared/http.ts";

export const mutationRefused = (cause: unknown) =>
  cause instanceof HttpError && [400, 401, 403, 404, 409, 412, 429].includes(cause.status);
