/**
 * One chat: the streamed timeline (messages, tool steps, approval cards with Allow once / Deny),
 * the composer with runtime / model / effort / permission pickers and photo attachments.
 * Attachment images load with the bearer header (`Image source={{ uri, headers }}`).
 */
import type { ApprovalRequest, Attachment } from '@uncage/client';
import {
  useApprovalActions,
  useAttachments,
  useMachines,
  useMessages,
  useRun,
  useSession,
  useSessions,
  useSessionSettings,
  useStoreSelector,
  useUncageError,
  useUncageStore,
  type MessageView,
  type TimelineItem,
  type ToolView,
} from '@uncage/react';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner, Button, Chip, PickerSheet, type PickerOption } from '../../components/ui';
import { useAuth } from '../../lib/app';
import { assetToFile } from '../../lib/attachments';
import { sanitizeId } from '../../lib/links';
import { useTheme } from '../../lib/theme';
import { bearerHeaders } from '../../lib/uncage';

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const PERMISSION_LABEL: Record<string, string> = {
  default: 'Ask before acting',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
};

/** An image attachment, fetched with the app token (the hub checks it like any request). */
function AttachmentImage({ attachment }: { attachment: Attachment }): JSX.Element {
  const store = useUncageStore();
  const { auth } = useAuth();
  const t = useTheme();
  const uri = store.attachmentUrl(attachment.id);
  return (
    <Image
      source={{ uri, headers: bearerHeaders(auth?.token) }}
      style={[styles.thumb, { backgroundColor: t.border }]}
      accessibilityLabel={attachment.name}
      resizeMode="cover"
    />
  );
}

function UserMessage({ message }: { message: MessageView }): JSX.Element {
  const t = useTheme();
  const attachments = useStoreSelector((s) => s.active?.runs[message.runId]?.attachments);
  return (
    <View style={{ alignItems: 'flex-end', marginVertical: 4 }}>
      {attachments && attachments.length > 0 && (
        <View style={styles.thumbRow}>
          {attachments.map((a) =>
            a.kind === 'image' ? (
              <AttachmentImage key={a.id} attachment={a} />
            ) : (
              <Text key={a.id} style={{ color: t.muted, fontSize: 12 }}>
                📎 {a.name}
              </Text>
            ),
          )}
        </View>
      )}
      <View style={[styles.userBubble, { backgroundColor: t.userBubble }]}>
        <Text style={{ color: t.text, fontSize: 15 }} selectable>
          {message.text}
        </Text>
      </View>
    </View>
  );
}

function AssistantMessage({ message }: { message: MessageView }): JSX.Element {
  const t = useTheme();
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={{ color: t.text, fontSize: 15, lineHeight: 22 }} selectable>
        {message.text}
        {message.streaming ? ' ▍' : ''}
      </Text>
    </View>
  );
}

function ToolRow({ tool }: { tool: ToolView }): JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const icon = tool.status === 'running' ? '…' : tool.status === 'completed' ? '✓' : tool.status === 'declined' ? '⊘' : '✕';
  const color = tool.status === 'completed' ? t.success : tool.status === 'running' ? t.muted : t.danger;
  const detail = tool.error ?? tool.output;
  return (
    <Pressable onPress={() => detail && setOpen((o) => !o)} accessibilityRole="button" style={styles.toolRow}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {tool.status === 'running' ? <ActivityIndicator size="small" /> : <Text style={{ color, width: 14 }}>{icon}</Text>}
        <Text style={{ color: t.muted, fontSize: 13, flex: 1 }} numberOfLines={open ? undefined : 1}>
          {tool.title || tool.name}
        </Text>
      </View>
      {open && detail ? (
        <Text style={[styles.toolOutput, { color: t.text, backgroundColor: t.bg, borderColor: t.border }]} selectable>
          {detail.length > 4000 ? `${detail.slice(0, 4000)}\n…` : detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }): JSX.Element {
  const t = useTheme();
  const { decide, pending } = useApprovalActions();
  const sending = pending[approval.id];
  const target = approval.target.command ?? approval.target.path ?? approval.target.host;
  const resolved = approval.state !== 'pending';
  return (
    <View style={[styles.approval, { borderColor: resolved ? t.border : t.warning, backgroundColor: t.surface }]}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{approval.title}</Text>
      {approval.description ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>{approval.description}</Text> : null}
      {target ? (
        <Text style={[styles.toolOutput, { color: t.text, backgroundColor: t.bg, borderColor: t.border }]} selectable numberOfLines={8}>
          {target}
        </Text>
      ) : null}
      {resolved ? (
        <Text style={{ color: approval.decision === 'allow' ? t.success : t.muted, marginTop: 8, fontSize: 13 }}>
          {approval.decision === 'allow' ? 'Allowed' : approval.decision === 'deny' ? 'Denied' : `Closed (${approval.state})`}
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <Button title="Allow once" onPress={() => void decide(approval.id, 'allow')} busy={sending === 'allow'} disabled={!!sending} style={{ flex: 1 }} />
          <Button title="Deny" kind="secondary" onPress={() => void decide(approval.id, 'deny')} busy={sending === 'deny'} disabled={!!sending} style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );
}

type Sheet = 'runtime' | 'model' | 'effort' | 'permission' | undefined;

/** Keyed by the session id, so switching chats starts with an empty draft. */
function Composer(): JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { run, isActive, send, cancel } = useRun();
  const { settings, capabilities, update, pendingForNextRun } = useSessionSettings();
  const attachments = useAttachments();
  const { session } = useSession();
  const machines = useMachines();
  const { create } = useSessions();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<Sheet>();
  const [pickError, setPickError] = useState<string | undefined>();

  const canAttach = capabilities?.attachments.images ?? false;
  const sendable = (text.trim().length > 0 || attachments.items.length > 0) && attachments.ready && !isActive;

  const submit = async () => {
    if (!sendable) return;
    const prompt = text.trim();
    setText('');
    if (!(await send(prompt))) setText(prompt);
  };

  const pickPhotos = async () => {
    setPickError(undefined);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 4,
        quality: 0.8,
        // iOS: hand over JPEG instead of HEIC (the hub accepts common web image types).
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (res.canceled) return;
      const files = await Promise.all(res.assets.map((a, i) => assetToFile(a, (input, init) => globalThis.fetch(input, init), i)));
      attachments.add(files);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    }
  };

  const current = session?.runtimeId;
  const machine = machines.machines.find((m) => m.id === session?.machineId);
  const runtimes = machine?.runtimes ?? [];
  const runtimeName = runtimes.find((r) => r.id === current)?.displayName ?? current ?? '…';

  const options: Record<Exclude<Sheet, undefined>, PickerOption[]> = {
    runtime: runtimes.map((r) => ({ value: r.id, label: r.displayName, hint: r.id === current ? 'This chat' : 'Starts a new chat', disabled: r.status !== 'available' })),
    model: (capabilities?.models ?? []).map((m) => ({ value: m.id, label: m.label, ...(m.description ? { hint: m.description } : {}) })),
    effort: (capabilities?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e })),
    permission: (capabilities?.permissionModes ?? []).map((p) => ({ value: p, label: PERMISSION_LABEL[p] ?? p })),
  };
  const modelLabel = capabilities?.models.find((m) => m.id === settings.model)?.label ?? settings.model ?? 'Default';

  const pick = async (which: Exclude<Sheet, undefined>, value: string) => {
    if (which === 'runtime') {
      if (value === current || !machine) return;
      try {
        const id = await create({ runtime: value, machineId: machine.id });
        router.replace({ pathname: '/chat/[id]', params: { id } });
      } catch {
        // shown by the error banner
      }
      return;
    }
    const patch = which === 'model' ? { model: value } : which === 'effort' ? { effort: value as typeof settings.effort } : { permissionMode: value as typeof settings.permissionMode };
    await update(patch);
  };

  return (
    <View style={[styles.composer, { borderColor: t.border, backgroundColor: t.surface, paddingBottom: Math.max(insets.bottom, 8) }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        <Chip label="Runtime" value={runtimeName} onPress={() => setSheet('runtime')} disabled={runtimes.length === 0} />
        {options.model.length > 0 && <Chip label="Model" value={modelLabel} onPress={() => setSheet('model')} />}
        {options.effort.length > 0 && (
          <Chip label="Effort" value={settings.effort ? (EFFORT_LABEL[settings.effort] ?? settings.effort) : 'Default'} onPress={() => setSheet('effort')} />
        )}
        {options.permission.length > 0 && (
          <Chip label="Permissions" value={PERMISSION_LABEL[settings.permissionMode ?? 'default'] ?? 'Default'} onPress={() => setSheet('permission')} />
        )}
      </ScrollView>
      {pendingForNextRun && <Text style={{ color: t.muted, fontSize: 12, marginHorizontal: 12 }}>Settings apply from the next message.</Text>}
      {attachments.items.length > 0 && (
        <View style={styles.attachRow}>
          {attachments.items.map((i) => (
            <View key={i.localId} style={[styles.attachChip, { borderColor: i.status === 'error' ? t.danger : t.border }]}>
              <Text style={{ color: t.text, fontSize: 12, maxWidth: 140 }} numberOfLines={1}>
                {i.status === 'uploading' ? '⏳ ' : i.status === 'error' ? '⚠ ' : ''}
                {i.name}
              </Text>
              <Pressable onPress={() => attachments.remove(i.localId)} hitSlop={8} accessibilityLabel={`Remove ${i.name}`}>
                <Text style={{ color: t.muted }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {attachments.rejected.length > 0 && (
        <Text style={{ color: t.danger, fontSize: 12, marginHorizontal: 12 }}>
          Not attached: {attachments.rejected.map((r) => `${r.name} (${r.reason === 'size' ? 'too large' : r.reason === 'count' ? 'too many' : 'type not supported'})`).join(', ')}
        </Text>
      )}
      {pickError && <Text style={{ color: t.danger, fontSize: 12, marginHorizontal: 12 }}>{pickError}</Text>}
      <View style={styles.inputRow}>
        {canAttach && (
          <Pressable onPress={() => void pickPhotos()} accessibilityRole="button" accessibilityLabel="Attach photos" hitSlop={8} style={styles.iconButton}>
            <Text style={{ color: t.accent, fontSize: 22 }}>＋</Text>
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={run && isActive ? 'The agent is working…' : 'Message the agent'}
          placeholderTextColor={t.muted}
          multiline
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
        />
        {isActive ? (
          <Button title="Stop" kind="danger" onPress={() => void cancel()} />
        ) : (
          <Button title="Send" onPress={() => void submit()} disabled={!sendable} />
        )}
      </View>
      <PickerSheet
        visible={sheet !== undefined}
        title={sheet === 'runtime' ? 'Runtime' : sheet === 'model' ? 'Model' : sheet === 'effort' ? 'Effort' : 'Permissions'}
        options={sheet ? options[sheet] : []}
        selected={
          sheet === 'runtime' ? current : sheet === 'model' ? settings.model : sheet === 'effort' ? settings.effort : (settings.permissionMode ?? 'default')
        }
        onPick={(v) => sheet && void pick(sheet, v)}
        onClose={() => setSheet(undefined)}
      />
    </View>
  );
}

export default function Chat(): JSX.Element {
  const t = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const id = sanitizeId(params.id) ?? '';
  const store = useUncageStore();
  const activeId = useStoreSelector((s) => s.activeSessionId);
  const { session, connection, replayIncomplete } = useSession();
  const { timeline, messages, tools } = useMessages();
  const { error, dismiss } = useUncageError();
  const listRef = useRef<FlatList<TimelineItem>>(null);

  useEffect(() => {
    if (id && store.getState().activeSessionId !== id) void store.actions.selectSession(id);
  }, [id, store]);

  const approvals = useStoreSelector((s) => s.active?.approvals);
  const items = useMemo(() => (activeId === id ? timeline : []), [activeId, id, timeline]);
  const ready = activeId === id && session?.id === id;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <Stack.Screen options={{ title: session?.id === id ? session.title || 'Chat' : 'Chat' }} />
      {error && <Banner kind="error" text={error.message} action={{ title: 'Dismiss', onPress: dismiss }} />}
      {ready && connection !== 'live' && (
        <Banner kind="warning" text={connection === 'offline' ? 'Offline: waiting for the connection…' : 'Reconnecting…'} />
      )}
      {ready && replayIncomplete && <Banner text="Older events are no longer available; the chat may be incomplete." />}
      {!ready ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {error ? <Text style={{ color: t.muted }}>This chat could not be opened.</Text> : <ActivityIndicator />}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => (item.kind === 'tools' ? `tools:${item.runId}:${item.toolIds[0] ?? ''}` : `${item.kind}:${item.id}`)}
          contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>Send a message to start.</Text>}
          renderItem={({ item }) => {
            if (item.kind === 'message') {
              const m = messages[item.id];
              if (!m) return null;
              return m.role === 'user' ? <UserMessage message={m} /> : <AssistantMessage message={m} />;
            }
            if (item.kind === 'tools') {
              return (
                <View style={[styles.toolGroup, { borderColor: t.border }]}>
                  {item.toolIds.map((tid) => {
                    const tool = tools[tid];
                    return tool ? <ToolRow key={tid} tool={tool} /> : null;
                  })}
                </View>
              );
            }
            const a = approvals?.[item.id];
            return a ? <ApprovalCard approval={a} /> : null;
          }}
        />
      )}
      {ready && <Composer key={id} />}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  userBubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', marginBottom: 4 },
  thumb: { width: 96, height: 96, borderRadius: 10 },
  toolGroup: { borderLeftWidth: 2, paddingLeft: 10, marginVertical: 6, gap: 4 },
  toolRow: { paddingVertical: 2 },
  toolOutput: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginTop: 6, padding: 8, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  approval: { borderWidth: 1, borderRadius: 12, padding: 12, marginVertical: 8 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  chips: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  attachChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12 },
  iconButton: { height: 44, justifyContent: 'center' },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 11, fontSize: 15 },
});
