/**
 * Home: the user's computers (online state, which one new chats run on), the chats, and "New chat"
 * with a runtime picker (the runtimes the chosen computer reports).
 */
import type { MachineInfo, Session } from '@uncage/client';
import { useMachines, useRunningSessions, useSessions, useUncageError } from '@uncage/react';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState, type JSX } from 'react';
import { FlatList, Pressable, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card, PickerSheet, SectionTitle } from '../components/ui';
import { secureStore, takePendingDeviceCode, useAuth } from '../lib/app';
import { sanitizeId } from '../lib/links';
import { describePush } from '../lib/push';
import { useTheme } from '../lib/theme';
import { sessionStorageAdapter } from '../lib/uncage';

/** The last open chat is reopened once per app launch (usePersistSession keeps it in SecureStore). */
let reopenedForLaunch = false;

function MachineRow({ machine, selected, onPress }: { machine: MachineInfo; selected: boolean; onPress(): void }): JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.row, { backgroundColor: t.surface, borderColor: selected ? t.accent : t.border }]}
    >
      <View style={[styles.dot, { backgroundColor: machine.online ? t.success : t.border }]} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{machine.name}</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {machine.online ? 'Online' : 'Offline'} · {machine.os} · agent {machine.agentVersion}
          {machine.agentOutdated ? ' · update needed' : ''}
        </Text>
      </View>
      {selected && <Text style={{ color: t.accent, fontSize: 12, fontWeight: '600' }}>New chats</Text>}
    </Pressable>
  );
}

function SessionRow({ session, machineName, running, onPress }: { session: Session; machineName?: string; running: boolean; onPress(): void }): JSX.Element {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[styles.row, { backgroundColor: t.surface, borderColor: t.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 15 }} numberOfLines={1}>
          {session.title || 'Untitled chat'}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>
          {session.runtimeId}
          {machineName ? ` · ${machineName}` : ''} · {new Date(session.createdAt).toLocaleString()}
        </Text>
      </View>
      {running && <Text style={{ color: t.accent, fontSize: 12, fontWeight: '600' }}>Running</Text>}
    </Pressable>
  );
}

export default function Home(): JSX.Element {
  const t = useTheme();
  const router = useRouter();
  const { auth, signOut, push, siteUrl } = useAuth();
  const machines = useMachines({ watch: 5000 });
  const { sessions, loading, reload, create } = useSessions();
  const { runs } = useRunningSessions();
  const { error, dismiss } = useUncageError();
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  // A /device link that arrived while signed out (app/+native-intent.tsx) opens now; else the
  // chat that was open when the app was last closed.
  const userId = auth?.user.id;
  useEffect(() => {
    const code = takePendingDeviceCode();
    if (code) {
      router.push({ pathname: '/device', params: { code } });
      return;
    }
    if (reopenedForLaunch || !userId) return;
    reopenedForLaunch = true;
    void Promise.resolve(sessionStorageAdapter(secureStore, userId).get())
      .then((stored) => {
        const id = sanitizeId(stored);
        if (id) router.push({ pathname: '/chat/[id]', params: { id } });
      })
      .catch(() => undefined);
  }, [router, userId]);

  const { loadInstallInfo } = machines;
  const noMachines = machines.connected && machines.machines.length === 0;
  useEffect(() => {
    if (noMachines) void loadInstallInfo();
  }, [noMachines, loadInstallInfo]);

  const target = machines.selected;
  const runtimeOptions = (target?.runtimes ?? []).map((r) => ({
    value: r.id,
    label: r.displayName,
    hint: r.status === 'available' ? r.version : (r.message ?? r.status),
    disabled: r.status !== 'available',
  }));

  const newChat = async (runtime: string) => {
    if (!target) return;
    setCreating(true);
    try {
      const id = await create({ runtime, machineId: target.id });
      router.push({ pathname: '/chat/[id]', params: { id } });
    } catch {
      // shown by the error banner (useUncageError)
    } finally {
      setCreating(false);
    }
  };

  const running = new Set(runs.map((r) => r.sessionId));
  const machineName = (id?: string) => machines.machines.find((m) => m.id === id)?.name;
  const install = machines.install;
  const setupCommand = install ? `${install.install}\n${install.setup}` : `uncage setup ${siteUrl ?? ''}`;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Uncage',
          headerRight: () => (
            <Pressable onPress={() => void signOut()} accessibilityRole="button" hitSlop={8}>
              <Text style={{ color: t.accent, fontSize: 15 }}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        refreshControl={
          <RefreshControl
            refreshing={loading || machines.loading}
            onRefresh={() => {
              void reload();
              void machines.refresh();
            }}
          />
        }
        ListHeaderComponent={
          <View>
            {error && <Banner kind="error" text={error.message} action={{ title: 'Dismiss', onPress: dismiss }} />}
            {machines.error && <Banner kind="warning" text={machines.error.message} />}
            <Text style={[styles.signedIn, { color: t.muted }]}>
              Signed in as {auth?.user.name} · {describePush(push)}
            </Text>
            <SectionTitle>Computers</SectionTitle>
            {noMachines && (
              <Card style={{ marginHorizontal: 12 }}>
                <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>Connect a computer</Text>
                <Text style={{ color: t.muted, fontSize: 13, marginBottom: 8 }}>
                  On your computer, install the Uncage agent and run this. It prints a QR code: scan it with your phone to approve the
                  computer here.
                </Text>
                <Text selectable style={[styles.code, { color: t.text, backgroundColor: t.bg, borderColor: t.border }]}>
                  {setupCommand}
                </Text>
                <Button title="Share command" kind="secondary" onPress={() => void Share.share({ message: setupCommand })} style={{ marginTop: 10 }} />
              </Card>
            )}
            {machines.machines.map((m) => (
              <MachineRow key={m.id} machine={m} selected={m.id === target?.id} onPress={() => machines.select(m.id)} />
            ))}
            <Button
              title="New chat"
              onPress={() => setPicking(true)}
              disabled={!target || !target.online}
              busy={creating}
              style={{ marginHorizontal: 12, marginTop: 12 }}
            />
            {target && !target.online && (
              <Text style={[styles.signedIn, { color: t.muted }]}>{target.name} is offline: start the agent on it to chat.</Text>
            )}
            <Button
              title="Approve a computer"
              kind="secondary"
              onPress={() => router.push('/device')}
              style={{ marginHorizontal: 12, marginTop: 8 }}
            />
            <SectionTitle>Chats</SectionTitle>
            {!loading && sessions.length === 0 && <Text style={[styles.signedIn, { color: t.muted }]}>No chats yet.</Text>}
          </View>
        }
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            machineName={machineName(item.machineId)}
            running={running.has(item.id)}
            onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
          />
        )}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
      <PickerSheet
        visible={picking}
        title={`New chat on ${target?.name ?? 'computer'}`}
        options={runtimeOptions}
        onPick={(runtime) => void newChat(runtime)}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginVertical: 4, padding: 12, borderRadius: 12, borderWidth: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  signedIn: { fontSize: 12, marginHorizontal: 16, marginTop: 10 },
  code: { fontFamily: 'Courier', fontSize: 13, padding: 10, borderRadius: 8, borderWidth: 1 },
});
