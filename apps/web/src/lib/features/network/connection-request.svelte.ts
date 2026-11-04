import { safeFailureDetail } from "@canopy/domain";
import { HttpError } from "#lib/shared/http.ts";

/** Keeps the last successful snapshot separate from the outcome of its latest refresh. */
export function useConnectionRequest<T>(initial: T, read: () => Promise<T>) {
  let data = $state.raw(initial);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state("");
  let revision = 0;

  function set(value: T) {
    revision++;
    data = value;
    loaded = true;
    error = "";
  }

  async function reload() {
    if (loading) return;
    loading = true;
    const started = revision;

    try {
      const value = await read();

      if (started === revision) set(value);
    } catch (cause) {
      if (started === revision)
        error =
          cause instanceof HttpError
            ? cause.message
            : cause instanceof Error && cause.name === "TimeoutError"
              ? "The request timed out. Check the connection to your gateway and retry."
              : "Could not reach the gateway. Check your connection and retry.";
      error = safeFailureDetail(error);
    } finally {
      loading = false;
    }
  }

  return {
    get data() {
      return data;
    },
    get loaded() {
      return loaded;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    reload,
    set,
  };
}
