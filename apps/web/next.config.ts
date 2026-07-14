import type { NextConfig } from "next";

/**
 * Security headers for every response. The CSP itself lives in
 * src/middleware.ts, which mints a per-request script nonce
 * ('nonce-…' + 'strict-dynamic', no 'unsafe-inline' for scripts).
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@fitmarket/ui", "@fitmarket/types", "@fitmarket/validation"],
  webpack: (config) => {
    // Workspace packages use NodeNext ESM imports (./x.js -> ./x.ts).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
