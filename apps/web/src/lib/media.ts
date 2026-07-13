import { publicEnv } from "./env";

/**
 * Public URL for PUBLIC-bucket media (avatars). Private media never uses
 * this — it goes through server-issued short-lived signed URLs instead.
 */
export function publicMediaUrl(bucket: string, objectKey: string): string {
  return `${publicEnv().NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectKey}`;
}
