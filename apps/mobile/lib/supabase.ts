import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

/**
 * Session material lives in the platform keychain/keystore via SecureStore —
 * never in plain AsyncStorage. Values larger than SecureStore's 2 KB chunk
 * limit are split defensively.
 */
const CHUNK = 1800;

const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    let value = head;
    let index = 1;
    // Reassemble chunked values.
    for (;;) {
      const part = await SecureStore.getItemAsync(`${key}.${index}`);
      if (part === null) break;
      value += part;
      index += 1;
    }
    return value;
  },
  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value.slice(0, CHUNK));
    let index = 1;
    for (let offset = CHUNK; offset < value.length; offset += CHUNK) {
      await SecureStore.setItemAsync(`${key}.${index}`, value.slice(offset, offset + CHUNK));
      index += 1;
    }
    await SecureStore.deleteItemAsync(`${key}.${index}`).catch(() => {});
  },
  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
    for (let index = 1; index < 10; index += 1) {
      await SecureStore.deleteItemAsync(`${key}.${index}`).catch(() => {});
    }
  },
};

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
  }
  client = createClient(url, anonKey, {
    auth: {
      storage: secureStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

export function apiBaseUrl(): string {
  const url = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!url) throw new Error("Missing EXPO_PUBLIC_API_BASE_URL");
  return url;
}
