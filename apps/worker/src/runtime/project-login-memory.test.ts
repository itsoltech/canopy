import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ThreadSecretDeliverySchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { projectSecretGuard } from "./project-secret-guard.ts";
import { loginRedactionValues } from "./project-login-values.ts";
import { ThreadSecretFiles, threadSecretOutputGuard } from "./thread-secrets.ts";

const temp = tempDirs();

function delivery(threadId: string, turnId: string, password: string, file?: { cwd: string }) {
  return create(ThreadSecretDeliverySchema, {
    threadId,
    turnId,
    requestId: crypto.randomUUID(),
    revision: 1,
    memoryOnly: !file,
    login: true,
    ...(file && { cwd: file.cwd }),
    value: JSON.stringify({
      name: "STAGING_ADMIN",
      username: "hidden-user",
      password,
      websites: ["https://staging.example.test"],
      hide_username: true,
    }),
    expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
  });
}

test("a browser login lease stays in memory for its turn and its values stay masked", () => {
  const files = new ThreadSecretFiles(temp("canopy-login-memory-"));
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const password = `pw-${crypto.randomUUID()}`;
  const lease = delivery(threadId, turnId, password);

  try {
    expect(files.apply(lease)).toMatchObject({ rejected: true, applied: false });
    // A browser login stays in worker memory, so it does not wait for the harness's output filter.
    files.beginProjectTurn(threadId, turnId);
    expect(files.apply(lease)).toMatchObject({ applied: true, rejected: false, file: "" });
    expect(existsSync(join(files.root, threadId)) ? readdirSync(join(files.root, threadId)) : []).toEqual([]);
    expect(files.readManualSecret(threadId, lease.requestId)).toBeUndefined();
    expect(files.readProjectLogin(threadId, crypto.randomUUID(), lease.requestId)).toBeUndefined();
    expect(files.readProjectLogin(threadId, turnId, lease.requestId)).toBe(lease.value);

    const basic = Buffer.from(`hidden-user:${password}`).toString("base64");

    const output = threadSecretOutputGuard(threadId).redact(
      `${password} ${encodeURIComponent(password)} ${basic} hidden-user`,
    );

    expect(output).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED]");

    files.rememberBrowserValues(threadId, loginRedactionValues(lease.value));
    files.finishProjectTurn(threadId, turnId);
    expect(files.readProjectLogin(threadId, turnId, lease.requestId)).toBeUndefined();
    // The page still holds what was entered; later turns keep masking it.
    expect(threadSecretOutputGuard(threadId).redact(password)).toBe("[REDACTED]");
    expect(threadSecretOutputGuard(crypto.randomUUID()).redact(password)).toBe(password);
  } finally {
    projectSecretGuard(threadId).reset();
    files.close();
  }
});

test("a login file masks its parts, not only the whole JSON", () => {
  const files = new ThreadSecretFiles(temp("canopy-login-file-"));
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const password = `pw-${crypto.randomUUID()}`;
  const lease = delivery(threadId, turnId, password, { cwd: temp("canopy-login-workspace-") });

  try {
    projectSecretGuard(threadId).ready();
    files.beginProjectTurn(threadId, turnId);
    const receipt = files.apply(lease);
    expect(receipt).toMatchObject({ applied: true, rejected: false });
    expect(receipt.file).not.toBe("");

    expect(threadSecretOutputGuard(threadId).redact(`${password} hidden-user ${encodeURIComponent(password)}`)).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  } finally {
    projectSecretGuard(threadId).reset();
    files.close();
  }
});
