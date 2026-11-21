import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import {
  assetNotices,
  bundledNotices,
  collectNotices,
  installedNotice,
  licenseAsset,
  mergeNotices,
  readNotices,
  releaseNotices,
} from "../../../scripts/open-source-licenses.ts";

export function licenseAssets() {
  const modules = new Set<string>();
  const external = new Set<string>();

  function track(): Plugin {
    return {
      name: "canopy-license-assets",
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;

          for (const id of chunk.moduleIds) modules.add(id);

          for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
            if (Object.hasOwn(bundle, specifier)) continue;
            const dependency = /^(?:@[^/]+\/)?[\w~-][\w.~@-]*(?=\/|$)/.exec(specifier)?.[0];

            if (dependency) external.add(dependency);
          }
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split("?")[0] !== `/${licenseAsset}`) return next();
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify(releaseNotices("web")));
        });
      },
    };
  }

  function write(client: string) {
    const desktopNotices = process.env["CANOPY_DESKTOP_LICENSES"];
    const web = "apps/web";

    const notices = mergeNotices(
      assetNotices("web"),
      bundledNotices(modules),
      [installedNotice(web, "tailwindcss")],
      collectNotices({ workspaces: [], dependencies: { workspace: web, names: [...external] } }),
      desktopNotices ? readNotices(readFileSync(desktopNotices, "utf8")) : [],
    );

    writeFileSync(join(client, licenseAsset), JSON.stringify(notices));
  }

  return { track, write };
}
