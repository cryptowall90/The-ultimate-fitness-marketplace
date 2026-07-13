import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { colors, MIN_TOUCH_TARGET } from "@/lib/theme";

export default function SignInScreen() {
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setInfo(null);
    setBusy(true);
    const client = supabase();
    if (mode === "sign_in") {
      const { error: err } = await client.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (err) {
        setError("Incorrect email or password.");
        return;
      }
      router.back();
    } else {
      if (password.length < 10) {
        setBusy(false);
        setError("Password must be at least 10 characters.");
        return;
      }
      const { error: err } = await client.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName.trim().slice(0, 80) } },
      });
      setBusy(false);
      if (err) {
        setError("We couldn't create the account. Check the details and try again.");
        return;
      }
      setInfo("Check your inbox to verify your email, then sign in.");
      setMode("sign_in");
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <Text style={styles.title}>{mode === "sign_in" ? "Sign in" : "Create account"}</Text>
      {mode === "sign_up" && (
        <TextInput
          style={styles.input}
          placeholder="Display name"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Display name"
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={80}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Password"
        secureTextEntry
        autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
        value={password}
        onChangeText={setPassword}
      />
      {error && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}
      {info && <Text style={styles.info}>{info}</Text>}
      <Pressable
        accessibilityRole="button"
        style={[styles.button, busy && styles.buttonDisabled]}
        disabled={busy}
        onPress={() => void submit()}
      >
        <Text style={styles.buttonText}>
          {busy ? "Please wait…" : mode === "sign_in" ? "Sign in" : "Create account"}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        style={styles.switch}
        onPress={() => setMode(mode === "sign_in" ? "sign_up" : "sign_in")}
      >
        <Text style={styles.switchText}>
          {mode === "sign_in" ? "New here? Create an account" : "Have an account? Sign in"}
        </Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: "center" },
  title: { fontSize: 24, fontWeight: "800", color: colors.text, marginBottom: 16 },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.text,
    marginBottom: 12,
  },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.primary,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.primaryContrast, fontWeight: "700", fontSize: 16 },
  switch: { marginTop: 16, minHeight: MIN_TOUCH_TARGET, justifyContent: "center" },
  switchText: { color: colors.primary, textAlign: "center", fontSize: 15 },
  error: { color: colors.danger, marginBottom: 8 },
  info: { color: colors.success, marginBottom: 8 },
});
