import { PROJECT_SECRET_MAX_BYTES, PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";

/** Same rule as the gateway: an agent passes this exact name (case matters) as `project_secret`. */
export function secretNameError(name: string, taken: readonly string[]): string {
  if (!name) return "Enter a name.";

  if (!PROJECT_SECRET_NAME_PATTERN.test(name))
    return "Use letters, digits and underscores, up to 128 characters. Start with a letter or underscore.";

  if (taken.includes(name)) return "This project already has a secret with this name. Use Replace value instead.";

  return "";
}

export function secretValueError(value: string): string {
  if (!value.length) return "Enter a value.";

  if (value.includes("\0")) return "Remove the null character from the value.";

  if (new TextEncoder().encode(value).length > PROJECT_SECRET_MAX_BYTES) return "Enter a value of 32 KB or less.";

  return "";
}
