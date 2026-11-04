import { isString } from "./json.ts";

/** Module fetch failures from Chromium, Firefox, Safari and Vite's CSS preloader. */
export function isModuleFetchError(cause: unknown): boolean {
  const seen = new Set<unknown>();

  while (cause && !seen.has(cause)) {
    seen.add(cause);
    const message = isString(cause) ? cause : cause instanceof Error ? cause.message : "";

    if (
      /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload css|loading (?:css )?chunk .+ failed/i.test(
        message,
      )
    )
      return true;
    cause = cause instanceof Object && "cause" in cause ? cause.cause : undefined;
  }

  return false;
}

/** One notice per tab; recovery waits for an explicit reload or the user's next navigation. */
export class UpdateNotice {
  available = false;

  constructor(readonly announce: () => void) {}

  detect(versionChanged: boolean, cause?: unknown): void {
    if (this.available || (!versionChanged && !isModuleFetchError(cause))) return;
    this.available = true;
    this.announce();
  }
}
