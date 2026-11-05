/**
 * The fixed OAuth redirect page (site/oauth/callback.html) returns a sign-in to the Canopy that started it.
 * The gateway puts the way back into `state`: `<nonce>.d` for the desktop app (canopy://oauth/callback) or
 * `<nonce>.w.<base64url callback>` for a web installation. The gateway stores only a hash of the whole state,
 * so a changed return target never matches. Runs in the gateway and, inlined, in the redirect page.
 */
export const OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";

export const DESKTOP_OAUTH_RETURN = "canopy://oauth/callback";

/** Query keys a provider returns; nothing else reaches the desktop app. */
export const OAUTH_RETURN_KEYS = ["code", "state", "error", "error_description", "iss"] as const;

const STATE = /^([\w-]{32,128})(?:\.(d)|\.w\.([\w-]{1,2800}))?$/;

function encode(text: string): string {
  let binary = "";

  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(text: string): string | undefined {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));

    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export const isOAuthState = (state: string) => STATE.test(state);

export function returnState(nonce: string, target: { desktop: true } | { callback: string }): string {
  return "desktop" in target ? `${nonce}.d` : `${nonce}.w.${encode(target.callback)}`;
}

/** A web callback must be this installation's callback path, without credentials, query or fragment. */
export function callbackTarget(raw: string): URL | undefined {
  try {
    const url = new URL(raw);

    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.pathname !== OAUTH_CALLBACK_PATH ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;

    return url;
  } catch {
    return undefined;
  }
}

/** Where the redirect page sends the browser, or undefined when the state carries no valid way back. */
export function returnTarget(search: string): { desktop: boolean; url: string } | undefined {
  const params = new URLSearchParams(search);
  const match = STATE.exec(params.get("state") ?? "");

  if (!match || (!match[2] && !match[3])) return undefined;

  if (match[2]) {
    const forwarded = new URLSearchParams();

    for (const key of OAUTH_RETURN_KEYS) {
      const value = params.get(key);

      if (value !== null) forwarded.set(key, value);
    }

    return { desktop: true, url: `${DESKTOP_OAUTH_RETURN}?${forwarded}` };
  }

  const callback = callbackTarget(decode(match[3]!) ?? "");

  return callback && { desktop: false, url: `${callback.origin}${callback.pathname}?${params}` };
}

/** One opaque string for the manual return: the user copies it from the redirect page into Canopy. */
export const pastedCode = (state: string, code: string) => encode(`${state} ${code}`);

export function parsePastedCode(text: string): { state: string; code: string } | undefined {
  const value = decode(text.trim());
  const space = value?.indexOf(" ") ?? -1;

  if (!value || space < 1) return undefined;
  const state = value.slice(0, space);
  const code = value.slice(space + 1);

  return isOAuthState(state) && code ? { state, code } : undefined;
}
