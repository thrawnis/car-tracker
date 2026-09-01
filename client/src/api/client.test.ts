import { describe, it, expect, beforeEach, vi } from "vitest";
import { apiFetch, setAccessToken, getAccessToken, ApiError } from "./client";

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(extraHeaders),
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  setAccessToken(null);
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("sends the access token as a bearer header when set", async () => {
    setAccessToken("token-123");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/vehicles");

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options.headers.Authorization).toBe("Bearer token-123");
    vi.unstubAllGlobals();
  });

  it("omits the Authorization header when no token is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/vehicles");

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options.headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns undefined for a 204 No Content response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch("/vehicles/1");
    expect(result).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("throws an ApiError with the server's message on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: "Invalid input" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/vehicles")).rejects.toMatchObject(
      expect.objectContaining({ message: "Invalid input", status: 400 }),
    );
    vi.unstubAllGlobals();
  });

  it("is an instance of ApiError with the response status attached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "Vehicle not found" }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await apiFetch("/vehicles/missing");
      expect.fail("expected apiFetch to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
    vi.unstubAllGlobals();
  });

  it("on 401, refreshes the access token once and retries the original request", async () => {
    setAccessToken("expired-token");
    const fetchMock = vi
      .fn()
      // Original request fails with 401.
      .mockResolvedValueOnce(jsonResponse(401, { error: "Not authenticated" }))
      // Refresh call succeeds with a new token.
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "fresh-token" }))
      // Retried original request succeeds.
      .mockResolvedValueOnce(jsonResponse(200, { data: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch("/vehicles");

    expect(result).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/auth/refresh");
    // The retried request uses the newly refreshed token, and the module's
    // in-memory access token has been updated for subsequent calls.
    expect(fetchMock.mock.calls[2]![1].headers.Authorization).toBe("Bearer fresh-token");
    expect(getAccessToken()).toBe("fresh-token");
    vi.unstubAllGlobals();
  });

  it("on 401 with a failed refresh, surfaces the original 401 error without retrying again", async () => {
    setAccessToken("expired-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "Not authenticated" }))
      .mockResolvedValueOnce(jsonResponse(401, { error: "Session expired" })); // refresh also fails
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/vehicles")).rejects.toMatchObject({ status: 401, message: "Not authenticated" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + refresh attempt, no infinite retry loop
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent 401s into a single refresh call", async () => {
    setAccessToken("expired-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "fresh-token" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: "one" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: "two" }));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([apiFetch("/one"), apiFetch("/two")]);

    expect(a).toEqual({ data: "one" });
    expect(b).toEqual({ data: "two" });
    const refreshCalls = fetchMock.mock.calls.filter((c) => c[0] === "/api/auth/refresh");
    expect(refreshCalls).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
