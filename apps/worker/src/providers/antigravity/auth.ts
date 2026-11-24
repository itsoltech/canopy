import type { Env } from "../profiles.ts";

type AntigravityAuth =
  | { readonly kind: "device" }
  | { readonly kind: "key"; readonly apiKey: string; readonly baseUrl?: string }
  | { readonly kind: "unavailable"; readonly problem: string };

/** Pair a custom Gemini endpoint with its own credential. A profile must never redirect the device's key. */
export function antigravityAuth(profile: Env, device: Env, linkDeviceLogin: boolean): AntigravityAuth {
  const profileKey = profile["GEMINI_API_KEY"];
  const profileUrl = profile["GOOGLE_GEMINI_BASE_URL"];

  if (profileUrl && !profileKey) {
    return {
      kind: "unavailable",
      problem: "Set the Gemini endpoint and its API key on the same Antigravity instance.",
    };
  }

  const apiKey = profileKey ?? device["GEMINI_API_KEY"];

  if (!apiKey) {
    return linkDeviceLogin
      ? { kind: "device" }
      : { kind: "unavailable", problem: "Set GEMINI_API_KEY or enable device login for Antigravity." };
  }

  const baseUrl = profileKey ? profileUrl : device["GOOGLE_GEMINI_BASE_URL"];

  if (baseUrl) {
    const parsed = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;

    if (
      !parsed ||
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        kind: "unavailable",
        problem: "The Gemini API endpoint must be an HTTP(S) URL without credentials or query parameters.",
      };
    }
  }

  return { kind: "key", apiKey, ...(baseUrl && { baseUrl }) };
}
