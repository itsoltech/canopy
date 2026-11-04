import installer from "../../../../../../scripts/install-worker.sh?raw";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url }) =>
  new Response(installer.replace("CANOPY_INSTALL_ORIGIN_DEFAULT", url.origin.replaceAll("'", "'\"'\"'")), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
