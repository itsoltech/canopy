import { classifyFailure, type FailureCode } from "./failures.ts";

const explanations: Record<FailureCode, string> = {
  auth_required: "Your provider login was rejected or has expired.",
  cli_missing:
    "The agent CLI is missing or does not start on this worker. Install it, or fix its path in provider settings.",
  model_unavailable: "This model is not available for this provider. Choose a different model.",
  usage_limit: "A usage or turn limit was reached. Wait for it to reset or check your plan, then retry.",
  network: "Canopy could not reach the provider, or the request timed out. Check the connection, then retry.",
  stream_cut_off:
    "The reply stopped before it was complete, possibly at its length limit. Retry with a shorter request, or change the model or reasoning effort.",
  process_exit:
    "The agent CLI stopped before it finished. Check what it already did, then retry. If it stops again, check provider settings.",
  configuration:
    "The provider rejected this request or its settings. Check the connection, credentials and model in provider settings.",
  connection_changed:
    "Codex could not use this thread with the current connection. Restore its previous connection in provider settings, then retry.",
  tool_approval: "The agent CLI blocked this Canopy tool before approval. Update the worker, then retry.",
  provider_unavailable: "The provider is temporarily unavailable. Retry in a few minutes.",
  internal: "Canopy had an internal error. Retry. If it happens again, copy the details and report them.",
};

/** How a turn or bot failure reads for people, from its message and code (web: FailureNotice, mobile: FailureNotice). */
export function failurePresentation(message: string, code: string, proxy: boolean) {
  const kind = classifyFailure(message, code);

  return {
    kind,
    explanation:
      kind === "auth_required" && proxy
        ? "The proxy rejected its credentials. Check its saved connection key, then test the proxy."
        : explanations[kind],
    model: kind === "model_unavailable" || kind === "stream_cut_off",
    settings: [
      "auth_required",
      "cli_missing",
      "configuration",
      "connection_changed",
      "process_exit",
      "usage_limit",
    ].includes(kind),
    proxy: proxy && ["auth_required", "configuration", "network", "provider_unavailable"].includes(kind),
  };
}
