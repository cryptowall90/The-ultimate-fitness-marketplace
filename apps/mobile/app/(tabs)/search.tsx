import { useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "@/lib/supabase";
import { colors, MIN_TOUCH_TARGET } from "@/lib/theme";

interface TrainerRow {
  trainer_id: string;
  display_name: string;
  headline: string;
  review_count: number;
  average_rating: number | null;
}

export default function SearchScreen() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TrainerRow[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  async function runSearch(text: string) {
    setQuery(text);
    if (text.trim().length < 2) {
      setRows([]);
      setState("idle");
      return;
    }
    setState("loading");
    const { data, error } = await supabase().rpc("search_trainers_online", {
      p_query: text.trim().slice(0, 120),
      p_limit: 20,
    });
    if (error) {
      setState("error");
      return;
    }
    setRows((data ?? []) as TrainerRow[]);
    setState("ready");
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search coaching styles, goals, names…"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Search trainers"
        value={query}
        onChangeText={(text) => void runSearch(text)}
        autoCapitalize="none"
        maxLength={120}
      />
      {state === "error" && <Text style={styles.error}>Search is unavailable right now.</Text>}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.trainer_id}
        ListEmptyComponent={
          state === "ready" ? (
            <Text style={styles.mutedCenter}>No trainers matched. Try different keywords.</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.name}>{item.display_name}</Text>
            <Text style={styles.muted}>{item.headline}</Text>
          </View>
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.text,
  },
  card: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 12,
  },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  muted: { color: colors.textMuted },
  mutedCenter: { color: colors.textMuted, textAlign: "center", marginTop: 24 },
  error: { color: colors.danger, marginTop: 8 },
});
