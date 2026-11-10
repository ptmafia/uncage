/**
 * The app shell: sign-in state (lib/app.tsx), the hub client (`UncageProvider`, one per signed-in
 * user), and the navigation stack. Signed out, only the sign-in screen is reachable.
 */
import { UncageProvider, usePersistSession, useReconnect } from '@uncage/react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, type JSX } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, isExpoGo, secureStore, useAuth } from '../lib/app';
import { sessionIdFromNotification } from '../lib/push';
import { useTheme } from '../lib/theme';
import { sessionStorageAdapter } from '../lib/uncage';

/** Effects that need the hub: session persistence, resume on foreground, notification taps. */
function HubEffects({ userId }: { userId: string }): null {
  const storage = useMemo(() => sessionStorageAdapter(secureStore, userId), [userId]);
  usePersistSession(storage);

  // A backgrounded app loses its event stream; resume it (after the last event) on return.
  const reconnect = useReconnect();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reconnect();
    });
    return () => sub.remove();
  }, [reconnect]);

  // A tapped push notification (`data.sessionId`) opens its chat. Development builds only.
  const router = useRouter();
  useEffect(() => {
    if (isExpoGo) return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    void import('expo-notifications').then((N) => {
      if (cancelled) return;
      N.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
      });
      const open = (data: unknown) => {
        const id = sessionIdFromNotification(data);
        if (id) router.push({ pathname: '/chat/[id]', params: { id } });
      };
      const last = N.getLastNotificationResponse();
      if (last) open(last.notification.request.content.data);
      const sub = N.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
      remove = () => sub.remove();
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [router]);
  return null;
}

function Navigation(): JSX.Element {
  const { loading, auth, client, siteUrl } = useAuth();
  const t = useTheme();
  if (!siteUrl) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.bg }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '700', marginBottom: 8 }}>No website configured</Text>
        <Text style={{ color: t.muted, textAlign: 'center' }}>
          Start Expo with EXPO_PUBLIC_HUB_URL set to the connected-demo URL, e.g. EXPO_PUBLIC_HUB_URL=http://192.168.1.20:3200 pnpm start
        </Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
        <ActivityIndicator />
      </View>
    );
  }
  const signedIn = auth !== undefined && client !== undefined;
  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)/sign-in" options={{ title: 'Sign in' }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: 'Uncage' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
        <Stack.Screen name="device" options={{ title: 'Approve computer', presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
  if (!signedIn) return stack;
  return (
    <UncageProvider key={auth.user.id} client={client}>
      <HubEffects userId={auth.user.id} />
      {stack}
    </UncageProvider>
  );
}

export default function RootLayout(): JSX.Element {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Navigation />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
