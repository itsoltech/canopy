const { withDangerousMod } = require("expo/config-plugins");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

/** @type {import("expo/config-plugins").ConfigPlugin} */
module.exports = (config) =>
  withDangerousMod(config, [
    "android",
    async (mod) => {
      const directory = join(mod.modRequest.platformProjectRoot, "app/src/main/res/xml");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "canopy_media_network.xml"),
        `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="${process.env.CANOPY_DEV_HTTP === "1" ? "true" : "false"}" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`,
      );

      return mod;
    },
  ]);
