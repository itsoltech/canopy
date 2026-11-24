import { expect, test } from "bun:test";
import { HttpError } from "builder-util-runtime";
import { updateErrorCode, updateLogger } from "../src/update-diagnostics.ts";

test("updater diagnostics keep differential failures distinct and omit untrusted details", () => {
  const lines: string[] = [];
  const logger = updateLogger((line) => lines.push(line));
  const detail = "private response body and signed download URL";
  logger.info(`Downloading update from ${detail}`);
  logger.error(`Cannot download differentially, fallback to full download: Error: ENOENT, open ${detail}`);
  logger.info(`Cannot run installer: error code: EACCES, error message: "${detail}"`);
  logger.warn(detail);
  logger.error(detail);
  expect(lines).toEqual([
    "download started",
    "full download fallback code=ENOENT",
    "installer launch failed code=EACCES",
  ]);
  expect(updateErrorCode(Object.assign(new Error(detail), { code: "ERR_UPDATER_INVALID_SIGNATURE" }))).toBe(
    "ERR_UPDATER_INVALID_SIGNATURE",
  );
  expect(updateErrorCode(new HttpError(403, detail))).toBe("HTTP 403");
  expect(updateErrorCode(new Error(detail))).toBe("unknown");
});
