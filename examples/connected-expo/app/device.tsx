/**
 * Approve a computer: opened by the CLI's QR code (`https://<site>/device?code=XXXX-XXXX`, via
 * verified app links) or from the home screen. `useDeviceApproval` looks the code up and approves
 * or denies it for the signed-in user (the hub's `GET /device/lookup` and `POST /device/decision`).
 *
 * Device-approval phishing guard: a code is pre-filled only when it came in a verified https app
 * link (lib/links.ts; +native-intent drops `uncagedemo://` codes), and then the user must type its
 * last 4 characters from their terminal before Approve works. A code the user typed whole needs no
 * extra step. Deny is always one tap.
 */
import { isWellFormedDeviceCode, maskDeviceCode, useDeviceApproval, type DeviceCodeSource } from '@uncage/react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Banner, Button, Card } from '../components/ui';
import { takePendingDeviceCode, useAuth } from '../lib/app';
import { isVerifiedLinkCode, sanitizeDeviceCode, timeAgo } from '../lib/links';
import { useTheme } from '../lib/theme';

const WARNING = 'Only approve if you just ran `uncage setup` on a computer in front of you. Never approve a code someone sent you.';

function Approval({ code, source }: { code: string; source: DeviceCodeSource }): JSX.Element {
  const t = useTheme();
  const router = useRouter();
  const { auth } = useAuth();
  const { lookup, state, error, confirmation, approve, deny } = useDeviceApproval(code, { source });
  const done = state === 'approved' || state === 'denied' || state === 'not_found' || state === 'expired';
  const fromLink = source === 'link';
  // From a link the last 4 characters are hidden (built from the compacted code): the user types
  // them from their own terminal.
  const shownCode = fromLink ? maskDeviceCode(code) : code.toUpperCase();

  if (state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={[styles.code, { color: t.text }]}>{shownCode}</Text>
      {fromLink ? (
        <Banner kind="warning" text={WARNING} />
      ) : (
        <Text style={{ color: t.muted, textAlign: 'center' }}>Check that this code matches the one in your terminal.</Text>
      )}
      {lookup && state !== 'not_found' && state !== 'expired' && (
        <Card>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{lookup.name ?? 'A computer'}</Text>
          {lookup.os ? <Text style={{ color: t.muted, marginTop: 2 }}>{lookup.os}</Text> : null}
          <Text style={{ color: t.text, marginTop: 10, lineHeight: 20 }}>
            {lookup.repairsMachine
              ? `This reconnects your computer "${lookup.repairsMachine.name}" to ${auth?.user.name ?? 'your account'}.`
              : `Approving lets the website and this app run the agent on this computer as ${auth?.user.name ?? 'you'}.`}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>Name and system: reported by the computer, not verified.</Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
            Requested {timeAgo(lookup.requestedAt)}
            {lookup.requestIp ? ` · IP as seen by the server: ${lookup.requestIp}` : ''}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>Expires {new Date(lookup.expiresAt).toLocaleTimeString()}</Text>
        </Card>
      )}
      {fromLink && state === 'idle' && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.text }}>
            Type the last 4 characters shown in the terminal of a computer you are sitting at. If someone gave you these characters, choose Deny.
          </Text>
          <TextInput
            value={confirmation.typed}
            onChangeText={confirmation.setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={16}
            placeholder="••••"
            placeholderTextColor={t.muted}
            accessibilityLabel="Last 4 characters of the code"
            style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]}
          />
        </View>
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
          <Button
            title="Approve"
            onPress={() => void approve()}
            busy={state === 'approving'}
            disabled={state !== 'idle' || !confirmation.matched}
            style={{ flex: 1 }}
          />
          <Button title="Deny" kind="secondary" onPress={() => void deny()} busy={state === 'denying'} disabled={state !== 'idle'} style={{ flex: 1 }} />
        </View>
      )}
    </ScrollView>
  );
}

/** Without a trusted code in the link: type the code shown by `uncage setup`. */
function EnterCode({ onCode, notice }: { onCode(code: string): void; notice?: string }): JSX.Element {
  const t = useTheme();
  const [value, setValue] = useState('');
  const code = sanitizeDeviceCode(value);
  return (
    <View style={styles.container}>
      {notice ? <Banner kind="warning" text={notice} /> : null}
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
  // Only a code from a verified https app link is pre-filled; any other `code` param is ignored.
  const fromParams = sanitizeDeviceCode(params.code);
  const linkCode = fromParams && isVerifiedLinkCode(fromParams) && isWellFormedDeviceCode(fromParams) ? fromParams : undefined;
  if (typed) return <Approval key={`typed:${typed}`} code={typed} source="typed" />;
  if (linkCode) return <Approval key={`link:${linkCode}`} code={linkCode} source="link" />;
  const notice = fromParams && isVerifiedLinkCode(fromParams) ? 'This link is not valid. Type the code shown in your terminal instead.' : undefined;
  return <EnterCode onCode={setTyped} {...(notice ? { notice } : {})} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 20, gap: 16 },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center', marginTop: 12, fontVariant: ['tabular-nums'] },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 20, letterSpacing: 3, textAlign: 'center' },
});
