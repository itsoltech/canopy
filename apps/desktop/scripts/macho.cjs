const {
  closeSync,
  openSync,
  readSync,
  writeSync,
  readdirSync,
  chmodSync,
  renameSync,
  rmSync,
  statSync,
} = require("node:fs");

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const magic = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

// Do not follow symlinks: PostgreSQL aliases refer to files signed at their real path.
function machOFiles(directory) {
  const result = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) result.push(...machOFiles(path));
    else if (entry.isFile()) {
      const descriptor = openSync(path, "r");

      try {
        const header = Buffer.alloc(4);

        if (readSync(descriptor, header, 0, 4, 0) === 4 && magic.has(header.toString("hex"))) result.push(path);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  return result;
}

// Inspect CPU headers directly so architecture guards can also be tested on Linux.
function machOArchitectures(path) {
  const fd = openSync(path, "r");

  try {
    const header = Buffer.alloc(8);

    if (readSync(fd, header, 0, 8, 0) !== 8 || !magic.has(header.subarray(0, 4).toString("hex"))) return [];
    const signature = header.subarray(0, 4).toString("hex");
    const fat = ["cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(signature);
    const little = ["cefaedfe", "cffaedfe", "bebafeca", "bfbafeca"].includes(signature);
    const integer = (buffer, offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
    const name = (cpu) => ({ 16777228: "arm64", 16777223: "x64", 12: "arm", 7: "ia32" })[cpu] ?? `cpu-${cpu}`;

    if (!fat) return [name(integer(header, 4))];
    const count = integer(header, 4);

    if (count < 1 || count > 16) throw new Error(`Invalid Mach-O architecture count: ${path}`);
    const stride = ["cafebabf", "bfbafeca"].includes(signature) ? 32 : 20;
    const table = Buffer.alloc(count * stride);

    if (readSync(fd, table, 0, table.length, 8) !== table.length)
      throw new Error(`Truncated Mach-O architecture table: ${path}`);

    return Array.from({ length: count }, (_, i) => name(integer(table, i * stride)));
  } finally {
    closeSync(fd);
  }
}

function thinMachOFiles(directory, arch, execute = execFileSync) {
  for (const path of machOFiles(directory)) {
    const architectures = machOArchitectures(path);

    if (!architectures.includes(arch)) throw new Error(`Mach-O missing ${arch}: ${path}`);

    if (architectures.length === 1) continue;
    const output = `${path}.thin`;

    try {
      execute("lipo", [path, "-thin", arch === "x64" ? "x86_64" : arch, "-output", output], { stdio: "inherit" });
      chmodSync(output, statSync(path).mode);
      renameSync(output, path);

      if (machOArchitectures(path).join() !== arch) throw new Error(`Thinning failed: ${path}`);
    } finally {
      rmSync(output, { force: true });
    }
  }
}

// Runtime downloads must work on Macs without Xcode Command Line Tools/lipo.
// A fat Mach-O stores complete independent slices. Copy only the requested one,
// then the installer applies a fresh ad-hoc signature before executing it.
function thinMachOFilesPortable(directory, arch) {
  const cpu = { arm64: 16777228, x64: 16777223 }[arch];

  if (!cpu) throw new Error(`Unsupported Mach-O architecture: ${arch}`);

  for (const path of machOFiles(directory)) {
    const architectures = machOArchitectures(path);

    if (!architectures.includes(arch)) throw new Error(`PostgreSQL Mach-O missing ${arch}: ${path}`);

    if (architectures.length === 1) continue;
    const input = openSync(path, "r");
    const output = `${path}.thin`;

    try {
      const header = Buffer.alloc(8);
      readSync(input, header, 0, 8, 0);
      const magic = header.subarray(0, 4).toString("hex");
      const little = ["bebafeca", "bfbafeca"].includes(magic);
      const wide = ["cafebabf", "bfbafeca"].includes(magic);
      const integer = (buffer, position) => (little ? buffer.readUInt32LE(position) : buffer.readUInt32BE(position));

      const integer64 = (buffer, position) =>
        Number(little ? buffer.readBigUInt64LE(position) : buffer.readBigUInt64BE(position));

      const stride = wide ? 32 : 20;
      const table = Buffer.alloc(integer(header, 4) * stride);

      if (readSync(input, table, 0, table.length, 8) !== table.length)
        throw new Error(`PostgreSQL Mach-O table truncated: ${path}`);

      let start = 0,
        size = 0;

      for (let entry = 0; entry < table.length; entry += stride) {
        if (integer(table, entry) !== cpu) continue;
        start = wide ? integer64(table, entry + 8) : integer(table, entry + 8);
        size = wide ? integer64(table, entry + 16) : integer(table, entry + 12);
        break;
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(size) ||
        start < 8 + table.length ||
        size < 8 ||
        start + size > statSync(path).size
      )
        throw new Error(`Invalid PostgreSQL Mach-O slice: ${path}`);
      const target = openSync(output, "wx", statSync(path).mode);

      try {
        const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));

        for (let copied = 0; copied < size;) {
          const bytes = readSync(input, buffer, 0, Math.min(buffer.length, size - copied), start + copied);

          if (!bytes) throw new Error(`PostgreSQL Mach-O slice truncated: ${path}`);

          for (let written = 0; written < bytes;) written += writeSync(target, buffer, written, bytes - written);
          copied += bytes;
        }
      } finally {
        closeSync(target);
      }

      renameSync(output, path);

      if (machOArchitectures(path).join() !== arch) throw new Error(`PostgreSQL thinning failed: ${path}`);
    } finally {
      closeSync(input);
      rmSync(output, { force: true });
    }
  }
}

module.exports = { machOFiles, machOArchitectures, thinMachOFiles, thinMachOFilesPortable };
