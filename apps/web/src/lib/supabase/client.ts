"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "../env.js";

/** Browser Supabase client — anon key only; RLS is the authorization boundary. */
export function createSupabaseBrowserClient() {
  const env = publicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
