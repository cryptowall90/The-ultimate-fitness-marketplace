import { jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";

export interface AuthenticatedUser {
  userId: string;
  role: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthenticatedUser;
    correlationId: string;
  }
}

/**
 * Verifies Supabase-issued access tokens (HS256, shared JWT secret). Tokens
 * arrive only via the Authorization header — never query strings.
 */
export function bearerAuth(jwtSecret: string): MiddlewareHandler {
  const key = new TextEncoder().encode(jwtSecret);
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), key, {
        algorithms: ["HS256"],
      });
      const sub = payload.sub;
      const role = typeof payload.role === "string" ? payload.role : "";
      if (!sub || role !== "authenticated") {
        return c.json({ error: { code: "unauthorized", message: "Invalid token" } }, 401);
      }
      c.set("user", { userId: sub, role });
    } catch {
      // Uniform response; no detail that helps token forgery.
      return c.json({ error: { code: "unauthorized", message: "Invalid token" } }, 401);
    }
    await next();
  };
}

/**
 * Requires a platform role from user_roles for the already-authenticated user.
 * Must run after bearerAuth. This service connects with privileged database
 * credentials, so the role check happens here — RLS does not apply.
 */
export function requireAppRole(pool: pg.Pool, role: "admin" | "moderator"): MiddlewareHandler {
  return async (c, next) => {
    const userId = c.get("user").userId;
    const res = await pool.query(
      `select 1 from user_roles where user_id = $1 and role = any($2)`,
      // admins satisfy moderator-level requirements
      [userId, role === "moderator" ? ["moderator", "admin"] : ["admin"]],
    );
    if (res.rowCount === 0) {
      // Uniform 404 would leak less, but admin endpoints are not secret;
      // 403 gives operators an actionable signal without exposing data.
      return c.json({ error: { code: "forbidden", message: "Insufficient privileges" } }, 403);
    }
    await next();
  };
}

/** Constant-time comparison for the scheduled-job bearer token. */
export function jobAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(expectedToken);
    const { timingSafeEqual } = await import("node:crypto");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
    }
    await next();
  };
}
