import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface TrainerRow {
  trainer_id: string;
  display_name: string;
  headline: string;
  service_mode: string;
  average_rating: number | null;
  review_count: number;
}

export default function DiscoverScreen() {
  const [rows, setRows] = useState<TrainerRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase().rpc("search_trainers_online", { p_limit: 20 });
      if (error) throw error;
      setRows((data ?? []) as TrainerRow[]);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.container}>
      {state === "error" ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Couldn&apos;t load trainers</Text>
          <Text style={styles.muted}>Check your connection and pull to retry.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.trainer_id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            state === "ready" ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No trainers yet</Text>
                <Text style={styles.muted}>Check back soon — new coaches join daily.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.card} accessibilityRole="summary">
              <Text style={styles.name}>{item.display_name}</Text>
              <Text style={styles.muted}>{item.headline}</Text>
              <Text style={styles.meta}>
                {item.review_count > 0
                  ? `★ ${Number(item.average_rating).toFixed(1)} (${item.review_count})`
                  : "New trainer"}
                {"  ·  "}
                {item.service_mode === "online" ? "Online" : "Online & in person"}
              </Text>
            </View>
          )}
          contentContainerStyle={{ padding: 16 }}
        />
      )}
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
  name: { fontSize: 17, fontWeight: "700", color: colors.text },
  muted: { color: colors.textMuted, marginTop: 2 },
  meta: { color: colors.text, marginTop: 8, fontSize: 13 },
  empty: { alignItems: "center", padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 4 },
});
