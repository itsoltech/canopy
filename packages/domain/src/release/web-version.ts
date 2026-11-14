/**
 * A web BFF sends its version to the gateway on every call, so a web app that no longer matches the gateway
 * (for example a separate canopy-web container left in an old Compose file) is noticed on both sides.
 * BFFs from before this header send none: the gateway treats that as older than itself.
 */
export const WEB_VERSION_HEADER = "canopy-web-version";

/** Moving from a separate web service to the web the gateway serves (docs/deploy.md). */
export const WEB_MIGRATION_DOCS =
  "https://github.com/itsoltech/canopy/blob/dev/docs/deploy.md#docker-compose-jeden-host";
