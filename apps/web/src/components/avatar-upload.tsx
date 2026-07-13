"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

const MAX_EDGE = 512; // avatars never need more; also strips EXIF/GPS
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

/**
 * Avatar upload per docs/MEDIA_PIPELINE.md: resize + re-encode on device
 * (drops metadata), then the signed-upload flow — request → direct PUT →
 * complete (the server verifies the actual bytes before publishing). Only
 * after the server publishes do we point profiles.avatar_media_id at it
 * (an RLS-guarded self-update).
 */
export function AvatarUpload({ currentUrl }: { currentUrl: string | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resizeToWebp(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.85),
      );
      if (!blob) throw new Error("encode failed");
      return blob;
    } finally {
      bitmap.close();
    }
  }

  async function onFileChosen(file: File) {
    if (!ACCEPTED.includes(file.type)) {
      setError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const blob = await resizeToWebp(file);
      const supabase = createSupabaseBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }

      const apiBase = publicEnv().NEXT_PUBLIC_API_BASE_URL;
      const requestRes = await fetch(`${apiBase}/v1/media/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: "avatar",
          contentType: blob.type,
          byteSize: blob.size,
          originalFilename: file.name.slice(0, 255),
        }),
      });
      if (!requestRes.ok) {
        setError("The upload could not be started. The image may be too large.");
        return;
      }
      const { mediaId, upload } = (await requestRes.json()) as {
        mediaId: string;
        upload: { url: string; method: string; headers: Record<string, string> };
      };

      const putRes = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: blob,
      });
      if (!putRes.ok) {
        setError("The upload failed. Please try again.");
        return;
      }

      const completeRes = await fetch(`${apiBase}/v1/media/uploads/${mediaId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!completeRes.ok) {
        setError("The image failed verification. Try a different photo.");
        return;
      }

      // RLS: users may only update their own profile row.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { error: linkError } = await supabase
        .from("profiles")
        .update({ avatar_media_id: mediaId })
        .eq("user_id", user.id);
      if (linkError) {
        setError("The photo uploaded but could not be set. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("The upload failed. Please check your connection and try again.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="field">
      {currentUrl ? (
        <img
          src={currentUrl}
          alt="Your profile photo"
          width={96}
          height={96}
          style={{ borderRadius: "50%", objectFit: "cover" }}
        />
      ) : null}
      <label htmlFor="avatarFile">Profile photo</label>
      <input
        id="avatarFile"
        ref={inputRef}
        className="input"
        type="file"
        accept={ACCEPTED.join(",")}
        disabled={busy}
        aria-busy={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFileChosen(file);
        }}
      />
      {busy && <p role="status">Uploading…</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
