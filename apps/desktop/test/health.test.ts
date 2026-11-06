import { expect, test } from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { HealthChecks } from "../src/runtime/health.ts";

function fixture() {
  let time = 0;
  let restarts = 0;
  const messages: string[] = [];

  const health = new HealthChecks(
    (name, message) => messages.push(`${name}: ${message}`),
    () => time,
  );

  const alive = async () => {};

  const dead = async () => {
    throw new ConnectError("deadline", Code.DeadlineExceeded);
  };

  const restart = async () => {
    restarts++;
  };

  health.started("gateway");

  const check = async (probe: () => Promise<void> = dead, ms = 5000) => {
    time += ms;

    if (health.poll()) await health.check("gateway", probe, restart);
  };

  return {
    health,
    alive,
    dead,
    restart,
    check,
    messages,
    advance: (ms: number) => {
      time += ms;
    },
    restarts: () => restarts,
  };
}

test("slow liveness and intermittent timeouts do not restart a working process", async () => {
  const f = fixture();
  await f.check(f.alive);

  for (let cycle = 0; cycle < 4; cycle++) {
    for (let failure = 0; failure < 5; failure++) await f.check();
    await f.check(async () => {
      f.advance(4500);
    });
  }

  expect(f.restarts()).toBe(0);
  expect(f.messages.some((message) => message.includes("timeout"))).toBe(true);
});

test("sustained failure restarts once after 30 seconds, and never kills the replacement during startup", async () => {
  const f = fixture();
  await f.check(f.alive);

  for (let failure = 0; failure < 6; failure++) await f.check();
  expect(f.restarts()).toBe(0);
  await f.check();
  expect(f.restarts()).toBe(1);
  f.health.started("gateway");

  for (let failure = 0; failure < 20; failure++) await f.check();
  expect(f.restarts()).toBe(1);
  expect(f.messages.at(-1)).toContain("waiting for startup");
});

test("resume resets accumulated failures, ignores stale results, and grants 30 seconds before polling", async () => {
  const f = fixture();
  await f.check(f.alive);

  for (let failure = 0; failure < 6; failure++) await f.check();
  let finish = () => {};

  const pending = f.health.check(
    "gateway",
    () =>
      new Promise<void>((_resolve, reject) => {
        finish = () => reject(new ConnectError("unavailable", Code.Unavailable));
      }),
    f.restart,
  );

  f.health.suspend();
  await f.check(f.dead, 5000);
  f.health.resume();
  finish();
  await pending;

  for (let tick = 0; tick < 5; tick++) await f.check();
  expect(f.restarts()).toBe(0);

  for (let tick = 0; tick < 6; tick++) await f.check();
  expect(f.restarts()).toBe(0);
  await f.check();
  expect(f.restarts()).toBe(1);
});

test("a timer gap or a probe spanning sleep grants grace without an Electron event", async () => {
  const f = fixture();
  await f.check(f.alive);

  for (let failure = 0; failure < 6; failure++) await f.check();
  await f.check(f.dead, 60_000);

  for (let tick = 0; tick < 5; tick++) await f.check();
  expect(f.restarts()).toBe(0);
  await f.check(async () => {
    f.advance(60_000);
    throw new Error("stale connection");
  });
  expect(f.health.poll()).toBe(false);
  expect(f.restarts()).toBe(0);
});

test("a result from a previous process cannot restart a new process", async () => {
  const f = fixture();
  await f.check(f.alive);

  for (let failure = 0; failure < 6; failure++) await f.check();
  await f.check(async () => {
    f.health.started("gateway");
    throw new ConnectError("old socket", Code.Unavailable);
  });
  expect(f.restarts()).toBe(0);
});

test("resume or a replacement during the departure announcement cancels the pending restart", async () => {
  for (const event of ["resume", "replacement"]) {
    const f = fixture();
    await f.check(f.alive);

    for (let failure = 0; failure < 6; failure++) await f.check();
    f.advance(5000);
    let prepared = false;
    let killed = false;
    await f.health.check("gateway", f.dead, async (current) => {
      prepared = true;
      await Promise.resolve();

      if (event === "resume") f.health.resume();
      else f.health.started("gateway");

      if (current()) killed = true;
    });
    expect(prepared).toBe(true);
    expect(killed).toBe(false);
  }
});
