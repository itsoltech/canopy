import release from "../canopy-version.json";

// Written before EAS copies the working tree or bundles an OTA update; no remote env injection needed.
export const CANOPY_VERSION = release.version;
