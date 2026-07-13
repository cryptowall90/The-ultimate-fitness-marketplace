import { expect, test } from "@playwright/test";

test.describe("public smoke", () => {
  test("home page renders with security headers", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /find a trainer/i })).toBeVisible();
  });

  test("service-role key never appears in the client bundle", async ({ page }) => {
    // Critical test 12: scan all loaded scripts and the HTML for privileged
    // secret markers.
    const bodies: string[] = [];
    page.on("response", async (response) => {
      const type = response.headers()["content-type"] ?? "";
      if (type.includes("javascript") || type.includes("html")) {
        bodies.push(await response.text().catch(() => ""));
      }
    });
    await page.goto("/");
    await page.goto("/search");
    const all = bodies.join("\n");
    expect(all).not.toContain("SUPABASE_SERVICE_ROLE");
    expect(all).not.toContain("service_role");
    expect(all).not.toMatch(/sk_(live|test)_/);
    expect(all).not.toContain("STRIPE_SECRET_KEY");
    expect(all).not.toContain("whsec_");
  });

  test("auth pages are reachable and keyboard accessible", async ({ page }) => {
    await page.goto("/auth/sign-in");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });
});
