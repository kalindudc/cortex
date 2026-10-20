import { describe, expect, test } from "bun:test";
import { CONTROL_PATHS } from "../../../src/api.ts";
import { isAppUrl, isExternalLink, parseBridgeRequest } from "../../../src/desktop/guard.ts";

const rejects = (value: unknown): void => {
  expect(() => parseBridgeRequest(value)).toThrow("invalid bridge request");
};

describe("parseBridgeRequest", () => {
  test("accepts a data route and drops the instance, host and content-length headers", () => {
    const parsed = parseBridgeRequest({
      method: "POST",
      path: "/api/tasks",
      headers: {
        "content-type": "application/json",
        "Cortex-Instance": "forged",
        Host: "evil",
        "Content-Length": "999",
      },
      body: '{"title":"x"}',
    });
    expect(parsed).toEqual({
      method: "POST",
      path: "/api/tasks",
      headers: { "content-type": "application/json" },
      body: '{"title":"x"}',
    });
  });

  test("rejects a value that is not an object", () => {
    for (const value of [null, undefined, "GET /api/tasks", 42, ["GET", "/api/tasks"]]) rejects(value);
  });

  test("rejects a method outside the allow-list", () => {
    rejects({ method: "TRACE", path: "/api/tasks" });
  });

  test("rejects a lower-case method", () => {
    rejects({ method: "get", path: "/api/tasks" });
  });

  test("rejects a path outside /api/", () => {
    rejects({ method: "GET", path: "/events" });
  });

  test("rejects a literal parent-directory segment", () => {
    rejects({ method: "GET", path: "/api/../etc/passwd" });
  });

  test("rejects an encoded parent-directory segment", () => {
    rejects({ method: "GET", path: "/api/%2e%2e/x" });
  });

  test("rejects a malformed percent-encoding", () => {
    rejects({ method: "GET", path: "/api/%zz" });
  });

  test("rejects a body or header value that is not a string", () => {
    rejects({ method: "POST", path: "/api/tasks", body: { title: "x" } });
    rejects({ method: "GET", path: "/api/tasks", headers: { accept: 1 } });
    rejects({ method: "GET", path: "/api/tasks", headers: "accept: */*" });
  });

  test("rejects the shutdown route", () => {
    rejects({ method: "POST", path: "/api/control/shutdown" });
  });

  test("rejects the shutdown route with upper-case letters", () => {
    rejects({ method: "POST", path: "/api/CONTROL/Shutdown" });
  });

  test("rejects the shutdown route with an encoded letter", () => {
    rejects({ method: "POST", path: "/api/%63ontrol/shutdown" });
  });

  test("rejects every control path", () => {
    for (const path of Object.values(CONTROL_PATHS)) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) rejects({ method, path });
    }
  });

  test("treats a '..' inside the query string as data", () => {
    expect(parseBridgeRequest({ method: "GET", path: "/api/tasks?q=v1..v2" }).path).toBe("/api/tasks?q=v1..v2");
  });
});

describe("isAppUrl", () => {
  test("accepts only the cortex://app origin", () => {
    const cases: [string | null | undefined, boolean][] = [
      ["cortex://app/", true],
      ["cortex://app/task/42?x=1", true],
      ["cortex://other/", false],
      ["cortex://user:pw@app/", false],
      ["cortex://app:8080/", false],
      ["https://app/", false],
      ["file:///etc/hosts", false],
      ["not a url", false],
      ["", false],
      [null, false],
      [undefined, false],
    ];
    for (const [url, expected] of cases) expect(isAppUrl(url), String(url)).toBe(expected);
  });
});

describe("isExternalLink", () => {
  test("accepts http, https and mailto only", () => {
    const cases: [string, boolean][] = [
      ["https://example.com/", true],
      ["http://example.com/a?b", true],
      ["mailto:someone@example.com", true],
      ["javascript:alert(1)", false],
      ["file:///etc/hosts", false],
      ["cortex://app/", false],
      ["data:text/html,hi", false],
      ["not a url", false],
    ];
    for (const [url, expected] of cases) expect(isExternalLink(url), url).toBe(expected);
  });
});
