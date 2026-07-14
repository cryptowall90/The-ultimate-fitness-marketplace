import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Link, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface ConversationRow {
  id: string;
  status: string;
  client_id: string;
  trainer_id: string;
  last_message_at: string | null;
}

export default function MessagesScreen() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    if (!userId) return;
    const client = supabase();
    // RLS returns only conversations the user participates in.
    const { data, error } = await client
      .from("conversations")
      .select("id, status, client_id, trainer_id, last_message_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) {
      setState("error");
      return;
    }
    const conversations = (data ?? []) as ConversationRow[];
    setRows(conversations);

    const counterpartIds = [
      ...new Set(conversations.map((c) => (c.client_id === userId ? c.trainer_id : c.client_id))),
    ];
    if (counterpartIds.length > 0) {
      const { data: profiles } = await client
        .from("profiles")
        .select("user_id, display_name")
        .in("user_id", counterpartIds);
      setNames(new Map((profiles ?? []).map((p) => [p.user_id, p.display_name])));
    }
    setState("ready");
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Messages</Text>
        <Text style={styles.muted}>Sign in to chat with your trainer during a program.</Text>
        <Link href="/auth/sign-in" style={styles.link} accessibilityRole="button">
          Sign in
        </Link>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          state === "ready" ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No conversations</Text>
              <Text style={styles.muted}>
                A conversation opens automatically when you start a program.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const counterpartId = item.client_id === userId ? item.trainer_id : item.client_id;
          const name = names.get(counterpartId) || "Conversation";
          return (
            <Pressable
              onPress={() => router.push(`/conversations/${item.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation with ${name}`}
              style={styles.row}
            >
              <Text style={styles.name}>{name}</Text>
              <Text style={styles.muted}>
                {item.status === "read_only" ? "Read only (program ended)" : "Active"}
                {item.last_message_at
                  ? ` · last message ${new Date(item.last_message_at).toLocaleDateString()}`
                  : ""}
              </Text>
            </Pressable>
          );
        }}
        contentContainerStyle={{ padding: 16 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 14,
    minHeight: 44,
  },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  muted: { color: colors.textMuted, marginTop: 2 },
  empty: { alignItems: "center", padding: 32, flex: 1, justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 4 },
  link: { color: colors.primary, marginTop: 12, fontSize: 16, padding: 12 },
});
