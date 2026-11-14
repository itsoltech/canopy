import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { descriptorPath } from "./descriptor-path.ts";
import { pathParts, rootChanged, type ImageFile, type ImageRoot } from "./export-root.ts";

const mac = process.platform === "darwin";

const native = () =>
  dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

const identity = (fd: number) => {
  const stat = fstatSync(fd, { bigint: true });

  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};

function unixImageFile(fd: number): ImageFile {
  let open = true;

  return {
    stat() {
      const stat = fstatSync(fd, { bigint: true });

      return {
        size: Number(stat.size),
        regular: stat.isFile(),
        links: Number(stat.nlink),
        version: `${stat.mtimeNs}:${stat.ctimeNs}`,
      };
    },
    path: () => descriptorPath(fd),
    read: (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close() {
      if (open) closeSync(fd);
      open = false;
    },
  };
}

/** Reopen each ancestor relative to its verified parent; no pathname can substitute a different root. */
export function unixImageRoot(path: string): ImageRoot {
  if (!["linux", "darwin"].includes(process.platform)) throw rootChanged();
  const { symbols } = (library ??= native());
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (mac ? 0x1000000 : 0x80000);
  const parts = pathParts(path);
  const identities: string[] = [];

  const walk = (capture: boolean) => {
    let fd = symbols.openat(mac ? -2 : -100, Buffer.from("/\0"), directory);

    if (fd < 0) throw rootChanged();

    try {
      for (let depth = 0; depth <= parts.length; depth++) {
        const current = identity(fd);

        if (capture) identities.push(current);
        else if (current !== identities[depth]) throw rootChanged();

        if (depth === parts.length) break;
        const next = symbols.openat(fd, Buffer.from(`${parts[depth]}\0`), directory);

        if (next < 0) throw rootChanged();
        closeSync(fd);
        fd = next;
      }

      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  };

  closeSync(walk(true));

  return {
    path,
    canonical: path,
    verify() {
      closeSync(walk(false));
    },
    open(children) {
      let fd = walk(false);

      try {
        for (const [index, part] of children.entries()) {
          const flags =
            index < children.length - 1
              ? directory
              : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (mac ? 0x1000000 : 0x80000);

          const next = symbols.openat(fd, Buffer.from(`${part}\0`), flags);

          if (next < 0) throw rootChanged();
          closeSync(fd);
          fd = next;
        }

        return unixImageFile(fd);
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    },
  };
}
