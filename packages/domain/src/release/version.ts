declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Injected at build time (bun build --define, Vite define) and set in the Docker images (docs/release.md). */
      readonly CANOPY_VERSION?: string;
    }
  }
}

/**
 * The Canopy version of this build: X.Y.Z (stable), X.Y.Z-beta.N or X.Y.Z-nightly.N.
 * Written as `process.env.CANOPY_VERSION` so the bundlers can replace it; a run from source reports 0.0.0-dev.
 */
export const CANOPY_VERSION: string = process.env.CANOPY_VERSION || "0.0.0-dev";

/** Build identity, independent of the administrator's preferred update channel. */
export function releaseChannel(version: string): "stable" | "beta" | "nightly" | "development" {
  if (/^\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(version)) return "stable";
  const pre = /^\d+\.\d+\.\d+-(beta|nightly)\.\d+(?:\+[\w.-]+)?$/.exec(version)?.[1];
  return pre === "beta" || pre === "nightly" ? pre : "development";
}
