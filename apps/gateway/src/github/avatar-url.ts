import { Code, ConnectError } from "@connectrpc/connect";

/** Public raster avatars only; reject redirects, credentials and arbitrary proxy destinations. */
export function avatarUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConnectError("Avatar unavailable", Code.InvalidArgument);
  }

  if (
    url.origin !== "https://avatars.githubusercontent.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/(u|in)\/[1-9][0-9]*$/.test(url.pathname) ||
    value.length > 1024 ||
    [...url.searchParams.keys()].some((key) => !["s", "v"].includes(key))
  )
    throw new ConnectError("Avatar unavailable", Code.InvalidArgument);
  url.searchParams.set("s", "64");

  return url.href;
}
