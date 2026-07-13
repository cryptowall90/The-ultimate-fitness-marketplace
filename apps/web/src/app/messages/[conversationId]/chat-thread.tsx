"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessageSchema } from "@fitmarket/validation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface Message {
  id: string;
  sender_id: string;
  kind: string;
  body: string;
  created_at: string;
}

const PAGE_SIZE = 50;

/**
 * Live message thread. All reads and sends go through the anon-key client:
 * RLS is the authorization boundary (participants read; sends require the
 * messaging entitlement via app.can_message). Realtime INSERT events also
 * pass RLS, so we only ever receive rows we're allowed to see.
 */
export function ChatThread({
  conversationId,
  userId,
  readOnly,
}: {
  conversationId: string;
  userId: string;
  readOnly: boolean;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const supabaseRef = useRef<ReturnType<typeof createSupabaseBrowserClient> | null>(null);

  function supabase() {
    supabaseRef.current ??= createSupabaseBrowserClient();
    return supabaseRef.current;
  }

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase()
      .from("messages")
      .select("id, sender_id, kind, body, created_at")
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (loadError) {
      setError("Messages could not be loaded.");
      return;
    }
    setMessages((data ?? []).reverse());
  }, [conversationId]);

  useEffect(() => {
    void load();
    const channel = supabase()
      .channel(`messages:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const message = payload.new as Message;
          setMessages((prev) =>
            prev === null || prev.some((m) => m.id === message.id) ? prev : [...prev, message],
          );
        },
      )
      .subscribe();
    return () => {
      void supabase().removeChannel(channel);
    };
  }, [conversationId, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    // Mark the newest counterpart message as read (RLS: own receipts only).
    const last = messages?.findLast((m) => m.sender_id !== userId);
    if (last) {
      void supabase()
        .from("message_receipts")
        .upsert(
          { message_id: last.id, user_id: userId, read_at: new Date().toISOString() },
          { onConflict: "message_id,user_id" },
        );
    }
  }, [messages, userId]);

  async function send() {
    const parsed = sendMessageSchema.safeParse({ conversationId, body: draft.trim() });
    if (!parsed.success) {
      setError("Messages must be between 1 and 8000 characters.");
      return;
    }
    setSending(true);
    setError(null);
    // RLS rejects the insert if messaging is no longer entitled (expiry,
    // block, refund) — the sender id always comes from the session.
    const { error: sendError } = await supabase().from("messages").insert({
      conversation_id: parsed.data.conversationId,
      sender_id: userId,
      body: parsed.data.body,
    });
    setSending(false);
    if (sendError) {
      setError("The message could not be sent — your access may have ended.");
      return;
    }
    setDraft("");
    await load(); // covers environments without Realtime
  }

  return (
    <div className="card">
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div
        style={{ maxHeight: "24rem", overflowY: "auto", padding: "var(--space-sm) 0" }}
        aria-live="polite"
      >
        {messages === null ? (
          <p>Loading messages…</p>
        ) : messages.length === 0 ? (
          <p>No messages yet — say hello.</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: m.sender_id === userId ? "flex-end" : "flex-start",
                margin: "var(--space-xs) 0",
              }}
            >
              <div
                className={m.sender_id === userId ? "chat-bubble chat-bubble-own" : "chat-bubble"}
                style={{
                  maxWidth: "75%",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "0.75rem",
                  background: m.sender_id === userId ? "var(--color-primary, #16a34a)" : "#e5e7eb",
                  color: m.sender_id === userId ? "#fff" : "inherit",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {m.body}
                <div style={{ fontSize: "0.7rem", opacity: 0.7, marginTop: "0.15rem" }}>
                  {new Date(m.created_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {!readOnly && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="form-stack"
        >
          <div className="field">
            <label htmlFor="message" className="visually-hidden">
              Message
            </label>
            <textarea
              id="message"
              className="input"
              rows={2}
              maxLength={8000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a message…"
            />
          </div>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={sending || draft.trim().length === 0}
            aria-busy={sending}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </div>
  );
}
