/** The web build inside a standalone gateway binary (scripts/build-binaries.ts --web). */
export interface EmbeddedWebArchive {
  /** Path of the embedded archive file (`$bunfs` inside the binary). */
  readonly file: string;
  /** Content hash, part of the extracted release directory name. */
  readonly key: string;
  readonly version: string;
}

/** Replaced when the binary is compiled with `--web`; source runs and headless builds have none. */
export const EMBEDDED_WEB: EmbeddedWebArchive | undefined = undefined;
