/** Clone URLs cross the worker boundary and enter .git/config: reject embedded secrets and executable transports. */
export function safeCloneUrl(url: string): { url: string } | { code: string; message: string } {
  const value = url.trim();

  if (!value || value.startsWith("-") || /\s/.test(value)) return { code: "INVALID_URL", message: "Enter a Git URL." };

  const scp = /^[\w.-]+@[\w.-]+:[^:]/.test(value) && !value.includes("://");

  if (scp && !/[?#]/.test(value)) return { url: value };
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { code: "INVALID_URL", message: "Enter a Git URL, e.g. https://github.com/owner/repo.git." };
  }

  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol))
    return { code: "INVALID_URL", message: "Use an https, ssh, git or file URL." };

  if (parsed.password || (parsed.username && parsed.protocol !== "ssh:") || parsed.search || parsed.hash)
    return {
      code: "URL_HAS_CREDENTIALS",
      message: "Remove the credentials and query from the URL. This computer's Git sign-in is used.",
    };

  return { url: value };
}
