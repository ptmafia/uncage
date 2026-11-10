/**
 * Approve a computer: opened by the CLI's QR code (`https://<site>/device?code=XXXX-XXXX`, via app
 * links, or `uncagedemo://device?code=…`). `useDeviceApproval` looks the code up and approves or
 * denies it for the signed-in user (the hub's `GET /device/lookup` and `POST /device/decision`).
 */
import { useDeviceApproval } from '@uncage/react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Banner, Button, Card } from '../components/ui';
import { takePendingDeviceCode, useAuth } from '../lib/app';
import { sanitizeDeviceCode } from '../lib/links';
import { useTheme } from '../lib/theme';

function Approval({ code }: { code: string }): JSX.Element {
  const t = useTheme();
  const router = useRouter();
  const { auth } = useAuth();
  const { lookup, state, error, approve, deny } = useDeviceApproval(code);
  const done = state === 'approved' || state === 'denied' || state === 'not_found' || state === 'expired';

  if (state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.code, { color: t.text }]}>{code.toUpperCase()}</Text>
      <Text style={{ color: t.muted, textAlign: 'center' }}>Check that this code matches the one in your terminal.</Text>
      {lookup && state !== 'not_found' && state !== 'expired' && (
        <Card>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{lookup.name ?? 'A computer'}</Text>
          {lookup.os ? <Text style={{ color: t.muted, marginTop: 2 }}>{lookup.os}</Text> : null}
          <Text style={{ color: t.text, marginTop: 10, lineHeight: 20 }}>
            {lookup.repairsMachine
              ? `This reconnects your computer "${lookup.repairsMachine.name}" to ${auth?.user.name ?? 'your account'}.`
              : `Approving lets the website and this app run the agent on this computer as ${auth?.user.name ?? 'you'}.`}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>Expires {new Date(lookup.expiresAt).toLocaleTimeString()}</Text>
        </Card>
      )}
      {state === 'approved' && <Banner text="Approved. The computer connects in a moment." />}
      {state === 'denied' && <Banner text="Denied. The computer was not connected." />}
      {state === 'not_found' && <Banner kind="warning" text="This code is unknown or was already used. Run uncage setup again for a new one." />}
      {state === 'expired' && <Banner kind="warning" text="This code has expired. Run uncage setup again for a new one." />}
      {error && <Banner kind="error" text={error.message} />}
      {done || state === 'error' ? (
        <Button title="Done" kind="secondary" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title="Approve" onPress={() => void approve()} busy={state === 'approving'} disabled={state !== 'idle'} style={{ flex: 1 }} />
          <Button title="Deny" kind="secondary" onPress={() => void deny()} busy={state === 'denying'} disabled={state !== 'idle'} style={{ flex: 1 }} />
        </View>
      )}
    </ScrollView>
  );
}

/** Without a code in the link: type the code shown by `uncage setup`. */
function EnterCode({ onCode }: { onCode(code: string): void }): JSX.Element {
  const t = useTheme();
  const [value, setValue] = useState('');
  const code = sanitizeDeviceCode(value);
  return (
    <View style={styles.container}>
      <Text style={{ color: t.text, fontSize: 15 }}>Enter the code that `uncage setup` shows in your terminal.</Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="ABCD-EFGH"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]}
        onSubmitEditing={() => code && onCode(code)}
      />
      <Button title="Continue" onPress={() => code && onCode(code)} disabled={!code} />
    </View>
  );
}

export default function DeviceScreen(): JSX.Element {
  const params = useLocalSearchParams<{ code?: string }>();
  // Opened directly: drop the copy +native-intent kept for the signed-out case.
  useEffect(() => {
    takePendingDeviceCode();
  }, []);
  const [typed, setTyped] = useState<string | undefined>();
  const code = sanitizeDeviceCode(params.code) ?? typed;
  return code ? <Approval key={code} code={code} /> : <EnterCode onCode={setTyped} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 20, gap: 16 },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center', marginTop: 12, fontVariant: ['tabular-nums'] },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 20, letterSpacing: 3, textAlign: 'center' },
});
