import { describe, expect, test } from "bun:test";
import { configuration, origin } from "../src/runtime/config.ts";

describe("desktop configuration boundary", () => {
  test("untrusted payloads cannot choose a mode without an object configuration", () => {
    for (const raw of ["null", "false", "42", '"local"', "[]", "{}", '{"mode":"other"}']) {
      expect(() => configuration(JSON.parse(raw))).toThrow();
    }
  });

  test("local bootstrap stays on loopback even with old saved interface settings", () => {
    for (const bindHost of [null, 42, "::1", "0.0.0.0", "127.0.0.1", "127.1.2.3", "example.com"]) {
      expect(configuration({ mode: "local", allowNetwork: true, bindHost })).toEqual({
        mode: "local",
        allowNetwork: false,
        bindHost: "127.0.0.1",
      });
    }

    expect(configuration({ mode: "local", allowNetwork: true, bindHost: "192.168.1.10" })).toEqual({
      mode: "local",
      allowNetwork: false,
      bindHost: "127.0.0.1",
    });
    expect(configuration({ mode: "local", allowNetwork: "true", bindHost: "0.0.0.0" })).toEqual({
      mode: "local",
      allowNetwork: false,
      bindHost: "127.0.0.1",
    });
  });

  test("remote origins reject paths, credentials and executable schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com/?query=1",
      "https://example.com/#hash",
      `https://${"a".repeat(2048)}.com`,
    ]) {
      expect(() => origin(value, "Gateway address")).toThrow();
    }

    const valid = { mode: "remote", gatewayUrl: "https://gateway.example.com/", webUrl: "https://web.example.com/" };

    for (const enrollmentToken of [null, 42, "short", "a".repeat(4097)]) {
      expect(() => configuration({ ...valid, enrollmentToken })).toThrow("Invalid enrollment token");
    }

    expect(configuration(valid)).toEqual({
      mode: "remote",
      gatewayUrl: "https://gateway.example.com",
      webUrl: "https://web.example.com",
    });
    expect(configuration({ ...valid, enrollmentToken: "a".repeat(16) })).toEqual({
      mode: "remote",
      gatewayUrl: "https://gateway.example.com",
      webUrl: "https://web.example.com",
      enrollmentToken: "a".repeat(16),
    });
    expect(() => configuration({ ...valid, gatewayUrl: null })).toThrow("Invalid Gateway address");
    expect(() => configuration({ ...valid, webUrl: 42 })).toThrow("Invalid Web address");
  });
});
