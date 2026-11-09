/**
 * Sign-in: `POST <site>/api/app/token` with a username (connected-demo's DEMO-ONLY login, no
 * password; the public demo ignores the name and creates a guest). A real site signs in with its
 * own authentication and returns its own token here.
 */
import { useState, type JSX } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Banner, Button, Card } from '../../components/ui';
import { useAuth } from '../../lib/app';
import { useTheme } from '../../lib/theme';

const USERNAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export default function SignIn(): JSX.Element {
  const { signIn, siteUrl } = useAuth();
  const t = useTheme();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const name = username.trim().toLowerCase();
  const valid = USERNAME.test(name);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // The home screen then opens a pending /device link, if one brought the user here.
      await signIn(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: t.text }]}>Your agent, in your pocket</Text>
        <Text style={[styles.lead, { color: t.muted }]}>
          Chat with the agent on your own computer through {siteUrl}. The computer runs the agent; this app and the website only
          relay.
        </Text>
        <Card>
          <Text style={[styles.label, { color: t.text }]}>Username</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            onSubmitEditing={() => void submit()}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="go"
            placeholder="e.g. alice"
            placeholderTextColor={t.muted}
            style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
          />
          <Text style={[styles.hint, { color: t.muted }]}>
            Use the same name as on the website to see the same computers and chats. Demo only: there is no password.
          </Text>
          <Button title="Sign in" onPress={() => void submit()} disabled={!valid} busy={busy} style={{ marginTop: 12 }} />
        </Card>
        {error && <Banner kind="error" text={error} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', marginTop: 24 },
  lead: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  hint: { fontSize: 12, marginTop: 8, lineHeight: 17 },
});
