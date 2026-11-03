/**
 * Preloaded by `bun test` (bunfig.toml): at the end of the whole run, the temp directories no scope removed. bun
 * test fires no "exit" event, and a skipped describe still runs its body (making directories) but not its afterAll.
 */
import { afterAll } from "bun:test";
import { removeTempDirs } from "./temp.ts";

afterAll(removeTempDirs);

