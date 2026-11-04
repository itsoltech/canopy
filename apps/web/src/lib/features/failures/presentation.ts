import { classifyFailure, type FailureCode } from "@canopy/domain";

const explanations: Record<FailureCode, string> = {
  auth_required: "Your provider login or credentials were rejected or expired.",
  cli_missing:
    "The provider CLI is missing or cannot start on the worker. Install it or fix its executable path in provider settings.",
  model_unavailable: "The selected model is unavailable for this provider instance. Choose another model.",
  usage_limit:
    "The provider or turn limit was reached. Check your usage or plan, wait for the limit to reset, then retry.",
  network: "The provider could not be reached or the request timed out. Check the connection, then retry.",
  stream_cut_off:
    "The response ended before completion or exhausted its output budget. Retry with a shorter request or change the model or reasoning effort.",
  process_exit:
    "The provider CLI exited before finishing. Check its installation and provider settings, then retry. Review any actions already completed.",
  configuration:
    "The provider rejected this configuration or request. Check its connection, credentials and model settings.",
  provider_unavailable: "The provider is temporarily unavailable. Retry after it recovers.",
  internal: "Canopy could not finish this turn. Retry; if it happens again, copy the details for troubleshooting.",
};

export function failurePresentation(message: string, code: string, proxy: boolean) {
  const kind = classifyFailure(message, code);

  return {
    kind,
    explanation:
      kind === "auth_required" && proxy
        ? "The proxy rejected its credentials. Check the saved connection key and test the proxy."
        : explanations[kind],
    model: kind === "model_unavailable" || kind === "stream_cut_off",
    settings: ["auth_required", "cli_missing", "configuration", "process_exit", "usage_limit"].includes(kind),
    proxy: proxy && ["auth_required", "configuration", "network", "provider_unavailable"].includes(kind),
  };
}
