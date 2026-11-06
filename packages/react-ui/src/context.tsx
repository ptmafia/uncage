import type { ApprovalRequest, RuntimeInfo } from '@uncage/protocol';
import { useRun, useRuntimes, useSession, type MessageView, type ToolView } from '@uncage/react';
import { createContext, useContext, useEffect, useState, type ComponentType, type JSX, type ReactNode } from 'react';
import { STRINGS, type Locale, type Strings } from './i18n.js';

export interface ChatComponents {
  UserMessage: ComponentType<{ message: MessageView }>;
  AssistantMessage: ComponentType<{ message: MessageView }>;
  ToolSteps: ComponentType<{ tools: ToolView[]; running: boolean }>;
  ApprovalCard: ComponentType<{ approval: ApprovalRequest }>;
  Composer: ComponentType;
  EmptyState: ComponentType;
}

interface UiConfig {
  locale: Locale;
  t: Strings;
  showTools: boolean;
  components: Partial<ChatComponents>;
}

const UiContext = createContext<UiConfig>({ locale: 'en', t: STRINGS.en, showTools: true, components: {} });

export const useUi = () => useContext(UiContext);

export interface UncageUIProviderProps {
  locale?: Locale;
  showTools?: boolean;
  components?: Partial<ChatComponents>;
  children: ReactNode;
}

/** Locale and component overrides for the default UI. `<AgentChat>` sets this up itself. */
export function UncageUIProvider({ locale = 'en', showTools = true, components = {}, children }: UncageUIProviderProps): JSX.Element {
  return (
    <UiContext.Provider value={{ locale, t: STRINGS[locale], showTools, components }}>{children}</UiContext.Provider>
  );
}

/**
 * What the composer and empty state act on. Inside `<AgentChat>` it is the chat's draft/session
 * controller; standalone it falls back to the active session.
 */
export interface ChatController {
  /** No session is open: the next prompt creates one with `runtimeId`. */
  draft: boolean;
  /** The runtime that will answer the next prompt. */
  runtimeId?: string;
  setRuntimeId(id: string): void;
  /** Resolves `true` once a run was started (the composer clears its text only then). */
  send(text: string): Promise<boolean>;
  starterPrompts: string[];
  /** Leaves the open session for a new draft (the read-only banner's "New session" button). */
  startNewSession?(): void;
}

export const ChatControllerContext = createContext<ChatController | null>(null);

export function useChatController(): ChatController {
  const ctx = useContext(ChatControllerContext);
  const { session } = useSession();
  const { send } = useRun();
  return (
    ctx ?? {
      draft: false,
      ...(session ? { runtimeId: session.runtimeId } : {}),
      setRuntimeId: () => {},
      send,
      starterPrompts: [],
    }
  );
}

/** The runtime's info (if listed) and a display name for it. */
export function useRuntimeInfo(runtimeId?: string): { info?: RuntimeInfo; name: string } {
  const { runtimes } = useRuntimes();
  const info = runtimeId === undefined ? undefined : runtimes.find((r) => r.id === runtimeId);
  return { ...(info ? { info } : {}), name: info?.displayName ?? runtimeId ?? 'Agent' };
}

/** Current time, re-rendering every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
