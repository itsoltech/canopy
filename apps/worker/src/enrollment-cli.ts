import { resolve } from "node:path";
import { enrollWorker, type EnrollmentOptions } from "./enroll.ts";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Use the terminal's line editing without echoing the invitation. Piped input has no prompt. */
function readEnrollmentToken(): Promise<string> {
  const terminal = process.stdin.isTTY === true;

  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const input = createInterface({ input: process.stdin, output: silent, terminal });

  if (terminal) process.stderr.write("Enrollment token (hidden): ");

  return new Promise<string>((resolve, reject) => {
    input.on("error", reject);
    input.once("close", () => resolve(""));
    input.once("line", resolve);
  }).finally(() => {
    input.close();

    if (terminal) process.stderr.write("\n");
  });
}

export async function enrollFromCli(options: Omit<EnrollmentOptions, "token">, self: string): Promise<number> {
  try {
    const token = await readEnrollmentToken();

    if (!token) {
      console.error("An enrollment token is required on stdin");

      return 64;
    }

    await enrollWorker({ ...options, token });
    const pathArg = `'${resolve(options.configPath).replaceAll("'", `'"'"'`)}'`;
    console.info(
      `Enrolled. Config saved with mode 0600: ${resolve(options.configPath)}\nStart: ${self} --config ${pathArg}\nFor a user service: ${self} service --config ${pathArg}`,
    );

    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Enrollment failed");

    return 78;
  }
}
