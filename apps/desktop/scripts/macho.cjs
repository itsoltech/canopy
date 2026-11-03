const { closeSync, openSync, readSync, readdirSync } = require("node:fs");
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
      } finally { closeSync(descriptor); }
    }
  }
  return result;
}
module.exports = { machOFiles };
