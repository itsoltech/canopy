import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { objectOf } from "@canopy/domain/json";
import { Schema } from "effect";

test("the distributed worker network exposes only the TCP relay and preserves the saved bootstrap address", () => {
  const file = readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8");
  const compose = Schema.decodeUnknownSync(Schema.JsonObject)(Bun.YAML.parse(file));
  const services = objectOf(objectOf(compose)["services"]);
  const worker = objectOf(services["worker"]);
  const gateway = objectOf(services["gateway"]);
  const relay = objectOf(services["worker-link"]);

  expect(worker["networks"]).toEqual(["default"]);
  expect(objectOf(worker["environment"])["CANOPY_WORKER_TRUSTED_HTTP_ORIGIN"]).toBe("http://gateway:7443");
  expect(gateway["networks"]).toEqual({ control: { aliases: ["gateway-upstream"] } });
  expect(objectOf(services["postgres"])["networks"]).toEqual(["control"]);
  expect(relay["networks"]).toEqual({ default: { aliases: ["gateway"] }, control: {} });
  expect(relay["command"]).toEqual(["TCP4-LISTEN:7443,reuseaddr,fork", "TCP4:gateway-upstream:7443"]);
  expect(relay["ports"]).toBeUndefined();
  expect(gateway["ports"]).toContain("${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}:3000");
});
