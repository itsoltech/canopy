/**
 * The typed path of the add-project browser: `~/GIT/pin` is the directory `~/GIT/` and the filter `pin`.
 * `~` stands for the worker's home directory; `..` segments collapse as soon as they are typed. Paths use the
 * worker's separator (`\` on Windows, where `/` is accepted too).
 */
export interface PathStyle {
  readonly sep: string;
  /** The worker's home directory, and its real path when that differs (a symlinked home). */
  readonly homes: readonly string[];
}

export interface TypedPath {
  /** Absolute directory whose entries are listed, or "" while the text names no directory. */
  readonly dir: string;
  /** The text after the last separator: filters the entries, or names a new directory. */
  readonly filter: string;
}

const isRoot = (path: string, sep: string) => (sep === "/" ? path === "/" : /^[a-z]:\\$/i.test(path));

const withSep = (path: string, sep: string) => (path.endsWith(sep) ? path : `${path}${sep}`);

/** Converts `/` to the worker's separator on Windows. */
const typed = (text: string, sep: string) => (sep === "/" ? text : text.replaceAll("/", sep));

/** `~/x` → `/home/me/x`. */
function expand(text: string, style: PathStyle): string {
  const home = style.homes[0] ?? "";

  if (text === "~") return home;

  return text.startsWith(`~${style.sep}`) ? `${withSep(home, style.sep)}${text.slice(2)}` : text;
}

/** `/home/me/x` → `~/x`; other paths stay as they are. */
export function collapse(path: string, style: PathStyle): string {
  for (const home of style.homes) {
    if (!home) continue;

    if (path === home) return "~";
    const prefix = withSep(home, style.sep);

    if (path.startsWith(prefix)) return `~${style.sep}${path.slice(prefix.length)}`;
  }

  return path;
}

/** The display text of a directory, ending with the separator (`~/GIT/`). */
export const directoryText = (path: string, style: PathStyle): string => withSep(collapse(path, style), style.sep);

/** Resolves `.` and `..` in an absolute path; never above its root. */
function normalize(path: string, sep: string): string {
  const root = sep === "/" ? "/" : (/^[a-z]:\\/i.exec(path)?.[0] ?? "");
  const parts: string[] = [];

  for (const part of path.slice(root.length).split(sep)) {
    if (!part || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return root + parts.join(sep);
}

export function parentOf(path: string, sep: string): string {
  return isRoot(path, sep) ? path : normalize(`${path}${sep}..`, sep) || path;
}

/** Splits the text; `dir` is "" when the directory part is not absolute (e.g. "GIT/"). */
export function parsePath(text: string, style: PathStyle): TypedPath {
  const value = expand(typed(text, style.sep), style);
  const cut = value.lastIndexOf(style.sep);

  if (cut < 0) return { dir: "", filter: value };
  const head = value.slice(0, cut + 1);
  const absolute = style.sep === "/" ? head.startsWith("/") : /^[a-z]:\\/i.test(head);

  return { dir: absolute ? normalize(head, style.sep) || head : "", filter: value.slice(cut + 1) };
}

/** The text with `..`/`.` segments of its directory collapsed (`~/GIT/../` → `~/`); unchanged otherwise. */
export function tidyText(text: string, style: PathStyle): string {
  const value = typed(text, style.sep);
  const cut = value.lastIndexOf(style.sep);

  if (cut < 0 || !/(^|[\\/])\.\.?([\\/]|$)/.test(value.slice(0, cut + 1))) return value;
  const { dir, filter } = parsePath(value, style);

  return dir ? `${directoryText(dir, style)}${filter}` : value;
}

/** The text one directory up (`~/GIT/pinpoint/` → `~/GIT/`); at the root it stays. */
export function upText(dir: string, style: PathStyle): string {
  return directoryText(parentOf(dir, style.sep), style);
}

/** Entries matching the filter: names starting with it first, then names containing it; hidden ones on request. */
export function matching(names: readonly string[], filter: string): string[] {
  const query = filter.toLowerCase();
  const visible = names.filter((name) => !name.startsWith(".") || query.startsWith("."));

  if (!query) return visible;
  const starts = visible.filter((name) => name.toLowerCase().startsWith(query));
  const contains = visible.filter((name) => !starts.includes(name) && name.toLowerCase().includes(query));

  return [...starts, ...contains];
}

/** The last segment of a Git URL or `owner/repo`, without `.git`: the default name of a clone. */
export function repositoryName(source: string): string {
  const last =
    source
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .pop() ?? "";

  return last.replace(/\.git$/i, "");
}
