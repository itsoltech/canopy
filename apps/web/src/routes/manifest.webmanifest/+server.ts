import { json } from "@sveltejs/kit";
import { shellIdentity } from "#lib/server/channel-identity.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const identity = await shellIdentity();

  return json(
    {
      id: "/",
      name: identity.displayName,
      short_name: identity.displayName,
      start_url: "/",
      display: "standalone",
      background_color: identity.background,
      theme_color: identity.background,
      icons: [192, 512].map((size) => ({
        src: `${identity.assets}/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
      })),
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } },
  );
};
