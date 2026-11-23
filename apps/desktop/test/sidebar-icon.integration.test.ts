import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { DESKTOP_SESSION_HEADER } from "../src/web-session.ts";
import { freePort } from "../src/runtime/config.ts";
import { Logs } from "../src/runtime/log.ts";
import { DesktopWeb } from "../src/runtime/web.ts";

const makeTemp = tempDirs();
const installedRuntime = process.env["CANOPY_DESKTOP_RUNTIME"];

test.skipIf(!installedRuntime)(
  "the packaged desktop BFF serves every encoding of the Nightly sidebar icon",
  async () => {
    const token = randomBytes(32).toString("hex");
    const origin = `http://127.0.0.1:${await freePort()}`;
    const entry = join(installedRuntime ?? "", "canopy-web.js");
    const web = new DesktopWeb(entry, new Logs(makeTemp("canopy-icon-smoke-")), token);
    const icon = "/channels/nightly/icon.svg";
    // The installer and the smoke runner may use different checkout line endings.
    const expected = readFileSync(join(import.meta.dir, "../../web/static", icon), "utf8").replaceAll("\r\n", "\n");

    try {
      await web.start(origin, { mode: "offline" });

      for (const encoding of ["identity", "br", "gzip"]) {
        const response = await fetch(origin + icon, {
          headers: { [DESKTOP_SESSION_HEADER]: token, "accept-encoding": encoding },
          signal: AbortSignal.timeout(3000),
        });

        const artwork = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        expect(response.headers.get("content-encoding")).toBe(encoding === "identity" ? null : encoding);
        expect(artwork.replaceAll("\r\n", "\n")).toBe(expected);
      }
    } finally {
      await web.stop();
    }
  },
);
