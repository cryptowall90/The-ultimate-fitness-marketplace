import { Pressable, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { colors, MIN_TOUCH_TARGET } from "@/lib/theme";

export default function ProfileScreen() {
  const { session } = useAuth();

  if (!session) {
    return (
      <View style={styles.empty}>
        <Text style={styles.title}>Welcome to FitMarket</Text>
        <Text style={styles.muted}>Sign in to manage your profile and purchases.</Text>
        <Link href="/auth/sign-in" style={styles.link} accessibilityRole="button">
          Sign in or create an account
        </Link>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Your account</Text>
      <Text style={styles.muted}>Signed in</Text>
      <Pressable
        accessibilityRole="button"
        style={styles.signOut}
        onPress={() => void supabase().auth.signOut()}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 22, fontWeight: "800", color: colors.text },
  muted: { color: colors.textMuted, marginTop: 6 },
  link: { color: colors.primary, marginTop: 16, fontSize: 16, padding: 12 },
  signOut: {
    marginTop: 24,
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    alignSelf: "flex-start",
  },
  signOutText: { color: colors.primary, fontWeight: "600", fontSize: 16 },
});
