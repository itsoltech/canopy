declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Injected at build time (bun build --define, Vite define) and set in the Docker images (docs/release.md). */
      readonly CANOPY_VERSION?: string;
    }
  }
}

/**
 * The Canopy version of this build (`scripts/version.ts`): `X.Y.Z` for a release, `X.Y.Z-main.<sha7>` for main.
 * Written as `process.env.CANOPY_VERSION` so the bundlers can replace it; a run from source reports 0.0.0-dev.
 */
export const CANOPY_VERSION: string = process.env.CANOPY_VERSION || "0.0.0-dev";
