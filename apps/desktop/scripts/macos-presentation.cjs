const { readdirSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { extractFile } = require("@electron/asar");

// afterPack runs after electron-builder has copied icon.icns and before the bundle is signed.
function prepareMacPresentation(resources, iconFile) {
  const { displayName } = JSON.parse(extractFile(join(resources, "app.asar"), "dist/identity.json"));
  const name = JSON.stringify(displayName);
  const strings = `"CFBundleDisplayName" = ${name};\n"CFBundleName" = ${name};\n`;

  const locales = readdirSync(resources, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".lproj"),
  );

  if (!locales.some((entry) => entry.name === "en.lproj")) throw new Error("Missing macOS development localization");

  for (const locale of locales)
    writeFileSync(join(resources, locale.name, "InfoPlist.strings"), strings, { flag: "wx" });

  // A replaced bundle keeps its path and ID. Give changed artwork a new resource URL.
  renameSync(join(resources, "icon.icns"), join(resources, iconFile));
}

module.exports = { prepareMacPresentation };
