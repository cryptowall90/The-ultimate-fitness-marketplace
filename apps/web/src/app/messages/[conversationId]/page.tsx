import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ChatThread } from "./chat-thread";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(conversationId)) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/messages/${conversationId}`);

  // RLS: only participants can read the conversation at all.
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, status, client_id, trainer_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) notFound();

  const counterpartId =
    conversation.client_id === user.id ? conversation.trainer_id : conversation.client_id;
  const { data: counterpart } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("user_id", counterpartId)
    .maybeSingle();

  return (
    <div>
      <p>
        <Link href="/messages">← All conversations</Link>
      </p>
      <h1>{counterpart?.display_name || "Conversation"}</h1>
      {conversation.status !== "active" && (
        <p className="notice" role="status">
          This conversation is read-only{" "}
          {conversation.status === "read_only"
            ? "because the program access period has ended."
            : "."}
        </p>
      )}
      <ChatThread
        conversationId={conversation.id}
        userId={user.id}
        readOnly={conversation.status !== "active"}
      />
    </div>
  );
}
