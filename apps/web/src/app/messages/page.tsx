import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/**
 * Conversation list. RLS only returns conversations the user participates
 * in; counterpart names come from profiles policies (public trainers, and
 * clients visible to their enrolled trainers).
 */
export default async function MessagesPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/messages");

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, status, kind, client_id, trainer_id, last_message_at")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const counterpartIds = [
    ...new Set(
      (conversations ?? []).map((c) => (c.client_id === user.id ? c.trainer_id : c.client_id)),
    ),
  ];
  const { data: profiles } = counterpartIds.length
    ? await supabase.from("profiles").select("user_id, display_name").in("user_id", counterpartIds)
    : { data: [] };
  const nameById = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));

  return (
    <div>
      <h1>Messages</h1>
      {(conversations ?? []).length === 0 ? (
        <div className="card">
          <p>
            No conversations yet. A conversation opens automatically when you buy a program (or when
            a client buys yours).
          </p>
        </div>
      ) : (
        <ul className="card" style={{ listStyle: "none", padding: "var(--space-md)" }}>
          {(conversations ?? []).map((c) => {
            const counterpartId = c.client_id === user.id ? c.trainer_id : c.client_id;
            return (
              <li key={c.id} style={{ padding: "var(--space-sm) 0" }}>
                <Link href={`/messages/${c.id}`}>
                  {nameById.get(counterpartId) || "Conversation"}
                </Link>{" "}
                {c.status === "read_only" && <span>(read-only)</span>}
                {c.last_message_at && (
                  <span style={{ marginLeft: "var(--space-sm)", opacity: 0.7 }}>
                    {new Date(c.last_message_at).toLocaleString()}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
