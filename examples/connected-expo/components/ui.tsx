/** A few plain building blocks (no component library): buttons, cards, banners, a picker sheet. */
import type { JSX, ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress(): void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : t.surface;
  const fg = kind === 'secondary' ? t.text : t.accentText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }): JSX.Element {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}>{children}</View>;
}

export function Banner({
  text,
  kind = 'info',
  action,
}: {
  text: string;
  kind?: 'info' | 'error' | 'warning';
  action?: { title: string; onPress(): void };
}): JSX.Element {
  const t = useTheme();
  const color = kind === 'error' ? t.danger : kind === 'warning' ? t.warning : t.muted;
  return (
    <View style={[styles.banner, { borderColor: color, backgroundColor: t.surface }]} accessibilityRole="alert">
      <Text style={[styles.bannerText, { color }]}>{text}</Text>
      {action && (
        <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8}>
          <Text style={{ color: t.accent, fontWeight: '600' }}>{action.title}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  const t = useTheme();
  return <Text style={[styles.section, { color: t.muted }]}>{children}</Text>;
}

/** A compact control that shows the current value and opens a `PickerSheet`. */
export function Chip({ label, value, onPress, disabled }: { label: string; value: string; onPress(): void; disabled?: boolean }): JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, { borderColor: t.border, backgroundColor: t.surface, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={{ color: t.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** A bottom sheet listing options; tapping one calls `onPick` and closes it. */
export function PickerSheet({
  visible,
  title,
  options,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selected?: string;
  onPick(value: string): void;
  onClose(): void;
}): JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: t.surface, paddingBottom: insets.bottom + 12 }]}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>{title}</Text>
        <ScrollView style={{ maxHeight: 420 }}>
          {options.length === 0 && <Text style={{ color: t.muted, padding: 16 }}>Nothing to choose from.</Text>}
          {options.map((o) => (
            <Pressable
              key={o.value}
              disabled={o.disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: o.value === selected, disabled: !!o.disabled }}
              onPress={() => {
                onPick(o.value);
                onClose();
              }}
              style={({ pressed }) => [styles.option, { borderColor: t.border, opacity: o.disabled ? 0.45 : pressed ? 0.7 : 1 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: o.value === selected ? '700' : '400' }}>{o.label}</Text>
                {o.hint ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{o.hint}</Text> : null}
              </View>
              {o.value === selected && <Text style={{ color: t.accent, fontSize: 16 }}>✓</Text>}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 10, padding: 10, marginHorizontal: 12, marginVertical: 6 },
  bannerText: { flex: 1, fontSize: 13 },
  section: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 8, marginHorizontal: 16 },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 160 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
