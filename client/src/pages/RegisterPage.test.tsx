import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RegisterPage } from "./RegisterPage";

beforeEach(() => {
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  );
}

describe("RegisterPage", () => {
  it("blocks submission client-side when passwords don't match, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^username$/i), "newuser");
    await user.type(screen.getByLabelText(/^email$/i), "new@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "supersecretpassword123");
    await user.type(screen.getByLabelText(/confirm password/i), "different-password");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("generates and wraps a vault key client-side, then submits it alongside the credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enrollToken: "enroll-token-abc" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^username$/i), "newuser");
    await user.type(screen.getByLabelText(/^email$/i), "new@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "supersecretpassword123");
    await user.type(screen.getByLabelText(/confirm password/i), "supersecretpassword123");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // PBKDF2 key derivation is genuinely async and slow (600k iterations), so
    // the register call lands a moment after the click, not synchronously.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/register", expect.anything()));

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.username).toBe("newuser");
    expect(body.email).toBe("new@example.com");
    expect(body.password).toBe("supersecretpassword123");
    // The vault fields must be present and must NOT be (or contain) the plaintext
    // password or anything obviously derived from it in the clear - they're opaque
    // ciphertext blobs.
    expect(body.vaultSalt).toEqual(expect.any(String));
    expect(body.vaultKeyWrappedByPassword).toEqual(expect.any(String));
    expect(body.vaultKeyWrappedByRecovery).toEqual(expect.any(String));
    expect(body.recoveryVerifier).toEqual(expect.any(String));
    for (const field of [body.vaultKeyWrappedByPassword, body.vaultKeyWrappedByRecovery, body.recoveryVerifier]) {
      expect(field).not.toContain("supersecretpassword123");
    }
    vi.unstubAllGlobals();
  }, 10000);
});
