import { useColorScheme } from 'react-native';

export interface Theme {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  userBubble: string;
  danger: string;
  success: string;
  warning: string;
}

const light: Theme = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  border: '#e2e5ea',
  text: '#17191c',
  muted: '#6b7280',
  accent: '#1f6feb',
  accentText: '#ffffff',
  userBubble: '#e8f0fe',
  danger: '#d1242f',
  success: '#1a7f37',
  warning: '#9a6700',
};

const dark: Theme = {
  bg: '#0f1115',
  surface: '#181b21',
  border: '#2a2f38',
  text: '#e8eaee',
  muted: '#9aa3af',
  accent: '#4c8dff',
  accentText: '#ffffff',
  userBubble: '#1d2a44',
  danger: '#ff6b6b',
  success: '#3fb950',
  warning: '#d29922',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
