import { importAuthoritySpans, importCredentialParameter, inspectImportUrl } from "@canopy/domain/import-url";
import type { Span } from "./secret-matcher.ts";

// Special schemes accept missing slashes. Other schemes require an authority delimiter, so a prose prefix
// cannot swallow an inner HTTPS URL. WHATWG ignores tabs and line breaks inside URLs; keep them in the match.
const URL_LIKE =
  /\b(?:(?:https?|ftp|wss?|file):|[A-Za-z][A-Za-z0-9+.-]*:[/\\])[^\s"'<>]+(?:[\t\r\n]+[^\s"'<>]+)*|\b[^\s/@:"'<>]+@[^\s/:"'<>]+:[^\s"'<>]+/gi;

/** A credential value with ambiguous text boundaries consumes its line; a line break consumes the field. */
function parameterEnd(text: string, start: number): number {
  let end = start;

  while (end < text.length && !/[&#]/.test(text[end]!)) end++;
  const value = text.slice(start, end);

  if (/[\r\n]/.test(value)) return text.length;

  if (/[\s"'`<>]/u.test(value)) {
    const line = text.indexOf("\n", start);

    return line < 0 ? text.length : line;
  }

  return end;
}

/** Canonical components determine sensitivity; ambiguous offsets hide the entire URL. */
export function urlCredentialSpans(text: string, sensitive: (value: string) => boolean): Span[] {
  const found: Span[] = importAuthoritySpans(text);

  for (const match of text.matchAll(URL_LIKE)) {
    const raw = match[0];
    const { url, credential } = inspectImportUrl(raw, sensitive);

    if (!credential) continue;

    if (!url || url.href !== raw) {
      found.push([match.index, match.index + raw.length]);
    }

    const authority = raw.indexOf("://") + 3;
    const at = raw.indexOf("@", authority);

    if ((url?.username || url?.password) && at >= authority) found.push([match.index + authority, match.index + at]);

    // Each raw parameter is parsed, rather than comparing its encoded spelling.
    const query = raw.search(/[?#]/);

    if (query < 0) continue;
    let start = query + 1;

    for (let end = start; end <= raw.length; end++) {
      if (end < raw.length && !/[&#;]/.test(raw[end]!)) continue;
      const parameter = raw.slice(start, end);

      const { credential: secretParameter, hideName } = importCredentialParameter(parameter, sensitive);

      if (secretParameter) {
        const equal = parameter.indexOf("=");
        const valueStart = match.index + start + equal + 1;
        found.push([hideName ? match.index + start : valueStart, parameterEnd(text, valueStart)]);
      }

      start = end + 1;
    }
  }

  return found;
}
