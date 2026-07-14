import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface MessageRow {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

interface ConversationRow {
  id: string;
  status: string;
  client_id: string;
  trainer_id: string;
}

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Live conversation thread. All reads and sends run on the anon-key client:
 * RLS is the authorization boundary (participants read; sends require the
 * messaging entitlement via app.can_message; the sender id always comes
 * from the session). Realtime INSERT events also pass RLS.
 */
export default function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { session } = useAuth();
  const userId = session?.user.id;

  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [counterpartName, setCounterpartName] = useState<string>("Conversation");
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList<MessageRow>>(null);

  const valid = typeof conversationId === "string" && UUID_RE.test(conversationId);

  const load = useCallback(async () => {
    if (!valid || !userId) return;
    const client = supabase();
    const { data: conv, error: convError } = await client
      .from("conversations")
      .select("id, status, client_id, trainer_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convError || !conv) {
      setState("error");
      return;
    }
    setConversation(conv as ConversationRow);

    const counterpartId = conv.client_id === userId ? conv.trainer_id : conv.client_id;
    const { data: profile } = await client
      .from("profiles")
      .select("display_name")
      .eq("user_id", counterpartId)
      .maybeSingle();
    if (profile?.display_name) setCounterpartName(profile.display_name);

    const { data: rows, error: messagesError } = await client
      .from("messages")
      .select("id, sender_id, body, created_at")
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (messagesError) {
      setState("error");
      return;
    }
    setMessages((rows ?? []) as MessageRow[]); // newest first (inverted list)
    setState("ready");

    // Mark the newest counterpart message read (RLS: own receipts only).
    const newest = (rows ?? []).find((m) => m.sender_id !== userId);
    if (newest) {
      void client
        .from("message_receipts")
        .upsert(
          { message_id: newest.id, user_id: userId, read_at: new Date().toISOString() },
          { onConflict: "message_id,user_id" },
        );
    }
  }, [conversationId, userId, valid]);

  useEffect(() => {
    void load();
    if (!valid) return;
    const client = supabase();
    const channel = client
      .channel(`m:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const message = payload.new as MessageRow;
          setMessages((prev) =>
            prev.some((m) => m.id === message.id) ? prev : [message, ...prev],
          );
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [conversationId, load, valid]);

  async function send() {
    const body = draft.trim();
    if (!body || body.length > 8000 || !userId || !valid) return;
    setSending(true);
    setSendError(null);
    // RLS rejects the insert if messaging is no longer entitled.
    const { error } = await supabase()
      .from("messages")
      .insert({ conversation_id: conversationId, sender_id: userId, body });
    setSending(false);
    if (error) {
      setSendError("The message could not be sent — your access may have ended.");
      return;
    }
    setDraft("");
    await load(); // covers environments without Realtime
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Sign in to view this conversation.</Text>
      </View>
    );
  }
  if (!valid || state === "error") {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>This conversation could not be loaded.</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={styles.backButton}
        >
          <Text style={styles.link}>← Back</Text>
        </Pressable>
      </View>
    );
  }

  const readOnly = conversation !== null && conversation.status !== "active";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to conversations"
          style={styles.backButton}
        >
          <Text style={styles.link}>←</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {counterpartName}
        </Text>
      </View>

      {readOnly && (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            This conversation is read-only — the program access period has ended.
          </Text>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        inverted
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={
          state === "ready" ? (
            <Text style={[styles.muted, styles.invertedEmpty]}>No messages yet — say hello.</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const own = item.sender_id === userId;
          return (
            <View style={[styles.bubbleRow, own ? styles.bubbleRowOwn : null]}>
              <View style={[styles.bubble, own ? styles.bubbleOwn : null]}>
                <Text style={own ? styles.bubbleTextOwn : styles.bubbleText}>{item.body}</Text>
                <Text style={own ? styles.timeOwn : styles.time}>
                  {new Date(item.created_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </View>
            </View>
          );
        }}
      />

      {sendError && (
        <Text style={styles.error} accessibilityRole="alert">
          {sendError}
        </Text>
      )}

      {!readOnly && (
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a message…"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={8000}
            accessibilityLabel="Message"
          />
          <Pressable
            onPress={() => void send()}
            disabled={sending || draft.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            style={[styles.sendButton, sending || !draft.trim() ? styles.sendDisabled : null]}
          >
            <Text style={styles.sendText}>{sending ? "…" : "Send"}</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 4,
  },
  backButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 17, fontWeight: "700", color: colors.text, flex: 1 },
  banner: { backgroundColor: colors.border, padding: 10 },
  bannerText: { color: colors.text, fontSize: 13 },
  bubbleRow: { flexDirection: "row", marginVertical: 3 },
  bubbleRowOwn: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "78%",
    backgroundColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOwn: { backgroundColor: colors.primary },
  bubbleText: { color: colors.text, fontSize: 15 },
  bubbleTextOwn: { color: "#fff", fontSize: 15 },
  time: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  timeOwn: { color: "#e6f4ea", fontSize: 11, marginTop: 2 },
  invertedEmpty: { transform: [{ scaleY: -1 }], textAlign: "center" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  sendButton: {
    minHeight: 44,
    minWidth: 64,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "700" },
  muted: { color: colors.textMuted },
  link: { color: colors.primary, fontSize: 18 },
  error: { color: "#b91c1c", paddingHorizontal: 16, paddingBottom: 4 },
});
