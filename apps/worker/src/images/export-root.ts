import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { imageRefusal } from "./export-source.ts";
import { unixImageRoot } from "./export-root-unix.ts";
import { windowsImageRoot } from "./export-root-windows.ts";

export interface ImageRoot {
  readonly path: string;
  readonly canonical: string;
  verify(): void;
  open(parts: readonly string[]): number;
}

export const rootChanged = () => imageRefusal("The image directory changed. Restore it before showing images.");

export function pathParts(path: string): string[] {
  return relative(parse(path).root, path).split(sep).filter(Boolean);
}

/** Identity, not modification time: creating legitimate children must not invalidate the scope. */
export function pathIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });

  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mode}`;
}

/** Assignment is the only time an alias may resolve to a trusted directory. Never rebase the scope on export. */
export function pinImageRoot(assigned: string): ImageRoot {
  if (!isAbsolute(assigned)) throw rootChanged();
  const alias = resolve(assigned);
  let path = parse(alias).root;
  const aliases = [path, ...pathParts(alias).map((part) => (path = join(path, part)))];
  const identities = aliases.map(pathIdentity);
  const canonical = realpathSync(alias);
  const native = process.platform === "win32" ? windowsImageRoot(canonical) : unixImageRoot(canonical);

  const verify = () => {
    try {
      if (aliases.some((value, i) => pathIdentity(value) !== identities[i]) || realpathSync(alias) !== canonical)
        throw rootChanged();
      native.verify();
    } catch {
      throw rootChanged();
    }
  };

  verify();

  return {
    path: alias,
    canonical,
    verify,
    open(parts) {
      verify();
      const fd = native.open(parts);

      return fd;
    },
  };
}
