/** Credential checks shared by import metadata masking and gateway plan validation. */
const CREDENTIAL_NAMES = new Set([
  "token",
  "key",
  "apikey",
  "accesstoken",
  "accesskey",
  "clientsecret",
  "secret",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "auth",
  "authorization",
  "authentication",
  "credential",
  "credentials",
  "session",
  "sessionid",
  "sig",
  "signature",
  "bearer",
  "code",
]);

const DECODE_LIMIT = 4;

/** Strict decoding rejects malformed escapes/UTF-8; unresolved nested encoding fails closed. */
function decodedParameter(raw: string, sensitive: (value: string) => boolean) {
  let value = raw.replaceAll("+", " ");
  let known = sensitive(value);

  for (let round = 0; round < DECODE_LIMIT; round++) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return { value, known, ambiguous: true };
    }

    known ||= sensitive(value);

    if (!value.includes("%")) return { value, known, ambiguous: false };
  }

  return { value, known, ambiguous: true };
}

/** One classifier for canonical URL validation and raw masking offsets. Only actual name=value pairs count. */
export function importCredentialParameter(parameter: string, sensitive: (value: string) => boolean = () => false) {
  const equal = parameter.indexOf("=");

  if (equal < 0) return { credential: false, hideName: false };
  const name = decodedParameter(parameter.slice(0, equal), sensitive);
  const value = decodedParameter(parameter.slice(equal + 1), sensitive);

  const tokens = name.value
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]/)
    .concat(name.value.toLowerCase());

  return {
    credential:
      name.ambiguous ||
      value.ambiguous ||
      name.known ||
      value.known ||
      tokens.some((token) => CREDENTIAL_NAMES.has(token)),
    hideName: name.known || name.ambiguous,
  };
}

/** Query and fragment use the same bounded, strict decoder, including nested percent escapes. */
export function importCredentialParams(text: string, sensitive: (value: string) => boolean = () => false): boolean {
  return text.split(/[&#;]/).some((parameter) => importCredentialParameter(parameter, sensitive).credential);
}

/** Only a complete hostname (or bracketed IPv6) and an optional numeric port establish a safe boundary. */
function validHost(authority: string): boolean {
  if (!/^(?:[\p{L}\p{N}_.%-]+|\[[\da-f:.]+\])(?::\d+)?$/iu.test(authority)) return false;

  try {
    const url = new URL(`https://${authority}`);

    const hostname = url.hostname;

    const valid =
      hostname.startsWith("[") ||
      hostname
        .replace(/\.$/, "")
        .split(".")
        .every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label));

    return !!hostname && valid && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Invalid authority tokens cannot delimit userinfo: the next @ may be across lines in the same field. */
export function importAuthoritySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const schemes = /\b(?:(?:https?|ftp|wss?|file):[/\\]*|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/gi;
  let covered = 0;
  let nextAt = text.indexOf("@");

  for (const match of text.matchAll(schemes)) {
    if (match.index < covered) continue;
    const start = match.index + match[0].length;
    let end = start;

    while (end < text.length && !/[\s/\\?#]/u.test(text[end]!)) end++;
    const authority = text.slice(start, end);
    const at = authority.lastIndexOf("@");

    if (at >= 0) {
      const gitUser = /^(?:git\+)?ssh:/i.test(match[0]) && authority.slice(0, at) === "git";

      if (!gitUser) spans.push([start, start + at]);
    } else if (!validHost(authority)) {
      if (nextAt >= 0 && nextAt < start) nextAt = text.indexOf("@", start);
      const line = text.indexOf("\n", start);
      covered = nextAt >= 0 ? nextAt + 1 : line >= 0 ? line : text.length;
      spans.push([match.index, covered]);
    }
  }

  return spans;
}

export function inspectImportUrl(value: string, sensitive: (value: string) => boolean = () => false) {
  // Git's scp syntax is not a WHATWG URL. Its fixed `git` user is a transport convention, not a credential.
  const scp = /^([^/@:\s]+)@([^/:\s]+):(.+)$/.exec(value);

  if (scp) return { credential: scp[1] !== "git" || /[?#]/.test(scp[3] ?? ""), url: undefined };

  try {
    const url = new URL(value);
    const gitUser = ["ssh:", "git+ssh:"].includes(url.protocol) && url.username === "git" && !url.password;

    const credential =
      (!gitUser && !!url.username) ||
      !!url.password ||
      importCredentialParams(url.search.slice(1), sensitive) ||
      importCredentialParams(url.hash.slice(1), sensitive);

    return { url, credential };
  } catch {
    // Ambiguous authority or query: never assume a failed parse makes a URL safe to show or persist.
    const authority = value.split(/[?#]/, 1)[0] ?? "";
    const query = value.search(/[?#]/);
    const params = query < 0 ? "" : value.slice(query + 1);

    return {
      url: undefined,
      credential:
        authority.includes("@") || importAuthoritySpans(value).length > 0 || importCredentialParams(params, sensitive),
    };
  }
}
