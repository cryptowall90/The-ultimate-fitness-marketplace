import { useCallback, useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface EnrollmentRow {
  id: string;
  status: string;
  access_ends_at: string | null;
  program_purchase_snapshots: { title: string } | null;
}

export default function ProgramsScreen() {
  const { session } = useAuth();
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase()
      .from("enrollments")
      .select("id, status, access_ends_at, program_purchase_snapshots(title)")
      .eq("client_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      setState("error");
      return;
    }
    setRows((data ?? []) as unknown as EnrollmentRow[]);
    setState("ready");
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Your programs live here</Text>
        <Text style={styles.muted}>Sign in to see active and past programs.</Text>
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
              <Text style={styles.emptyTitle}>No programs yet</Text>
              <Text style={styles.muted}>Purchased programs appear here after checkout.</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const expired = item.status === "expired" || item.status === "refunded";
          return (
            <View style={styles.card}>
              <Text style={styles.name}>{item.program_purchase_snapshots?.title ?? "Program"}</Text>
              <Text style={expired ? styles.expired : styles.active}>
                {item.status.replaceAll("_", " ")}
              </Text>
              {item.access_ends_at && (
                <Text style={styles.muted}>
                  Access {expired ? "ended" : "ends"}{" "}
                  {new Date(item.access_ends_at).toLocaleDateString()}
                </Text>
              )}
            </View>
          );
        }}
        contentContainerStyle={{ padding: 16 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.bgSubtle,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text },
  active: { color: colors.success, marginTop: 4, textTransform: "capitalize" },
  expired: { color: colors.textMuted, marginTop: 4, textTransform: "capitalize" },
  muted: { color: colors.textMuted, marginTop: 4 },
  empty: { alignItems: "center", padding: 32, flex: 1, justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 4 },
  link: { color: colors.primary, marginTop: 12, fontSize: 16, padding: 12 },
});
