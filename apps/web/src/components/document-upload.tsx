"use client";

import { useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

const MAX_PDF_BYTES = 10_485_760; // server enforces the same cap

/**
 * PDF upload for credential documents. Runs the signed-upload flow
 * (request → direct PUT → complete; the server verifies the bytes are a
 * real PDF and quarantines it for scanning), then exposes the media id via
 * a hidden input so the surrounding server-action form can attach it.
 */
export function DocumentUpload({ name }: { name: string }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFileChosen(file: File) {
    if (file.type !== "application/pdf") {
      setError("Credential documents must be PDF files.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("PDFs can be at most 10 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    setMediaId(null);
    try {
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
          kind: "credential_document",
          contentType: file.type,
          byteSize: file.size,
          originalFilename: file.name.slice(0, 255),
        }),
      });
      if (!requestRes.ok) {
        setError("The upload could not be started. The file may be too large.");
        return;
      }
      const body = (await requestRes.json()) as {
        mediaId: string;
        upload: { url: string; method: string; headers: Record<string, string> };
      };

      const putRes = await fetch(body.upload.url, {
        method: body.upload.method,
        headers: body.upload.headers,
        body: file,
      });
      if (!putRes.ok) {
        setError("The upload failed. Please try again.");
        return;
      }

      const completeRes = await fetch(`${apiBase}/v1/media/uploads/${body.mediaId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!completeRes.ok) {
        setError("The document failed verification — make sure it is a real PDF.");
        return;
      }
      setMediaId(body.mediaId);
    } catch {
      setError("The upload failed. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor="credentialDocument">Certificate PDF (optional, speeds up review)</label>
      <input
        id="credentialDocument"
        ref={inputRef}
        className="input"
        type="file"
        accept="application/pdf"
        disabled={busy}
        aria-busy={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFileChosen(file);
        }}
      />
      {/* Consumed by the surrounding server-action form. */}
      <input type="hidden" name={name} value={mediaId ?? ""} />
      {busy && <p role="status">Uploading document…</p>}
      {mediaId && !busy && (
        <p role="status">✓ Document attached — it will be scanned before review.</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
