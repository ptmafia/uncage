import { useMessages, useRun, useRuntimes, useSessions, useUncageStore } from '@uncage/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ChatControllerContext, cx, UncageUIProvider, useUi, type ChatComponents, type ChatController } from '../context.js';
import type { Locale } from '../i18n.js';
import { Composer as DefaultComposer } from './Composer.js';
import { ConnectionBanner } from './ConnectionBanner.js';
import { ConversationHeader } from './ConversationHeader.js';
import { EmptyState as DefaultEmptyState } from './EmptyState.js';
import { MessageList } from './MessageList.js';
import { RunStatusBar } from './RunStatusBar.js';
import { pickRuntime } from './RuntimeSelector.js';
import { SessionSidebar } from './SessionSidebar.js';

export interface AgentChatProps {
  /** UI language (default `'en'`). */
  locale?: Locale;
  /** Sets `data-theme` on the root (default `'light'`; `'auto'` follows the OS). */
  theme?: 'light' | 'dark' | 'auto';
  /** Show the session sidebar (default `true`). */
  sidebar?: boolean;
  /** Runtime id preselected for new sessions (default: first available). */
  defaultRuntime?: string;
  /** Prompts offered on the empty state. */
  starterPrompts?: string[];
  /** Show tool steps between messages (default `true`). */
  showTools?: boolean;
  /** Replace any of the default building blocks. */
  components?: Partial<ChatComponents>;
  className?: string;
}

/** Keeps a scroll container pinned to the bottom while the user has not scrolled up. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return { ref, onScroll };
}

interface LayoutProps {
  sidebar: boolean;
  theme: string;
  className?: string;
  defaultRuntime?: string;
  starterPrompts: string[];
}

function ChatLayout({ sidebar, theme, className, defaultRuntime, starterPrompts }: LayoutProps): JSX.Element {
  const { locale, components } = useUi();
  const controller = useChatSession(defaultRuntime, starterPrompts);
  const { draft } = controller.value;
  const { activeSessionId, select } = useSessions();
  const { messages } = useMessages();
  const scroll = useStickToBottom(messages);
  const Composer = components.Composer ?? DefaultComposer;
  const EmptyState = components.EmptyState ?? DefaultEmptyState;

  return (
    <ChatControllerContext.Provider value={controller.value}>
      <div className={cx('uc-root', 'uc-chat', className)} data-theme={theme} lang={locale}>
        {sidebar && (
          <SessionSidebar
            {...(draft ? { activeId: undefined } : activeSessionId !== undefined ? { activeId: activeSessionId } : {})}
            onSelect={(id) => {
              controller.setDraft(false);
              void select(id);
            }}
            onNew={() => controller.setDraft(true)}
          />
        )}
        <main className="uc-main">
          {!draft && <ConversationHeader />}
          <div className="uc-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
            <div className="uc-column">
              <ConnectionBanner />
              {draft ? <EmptyState /> : <MessageList />}
            </div>
          </div>
          <div className="uc-dock">
            <div className="uc-column">
              {!draft && <RunStatusBar />}
              <Composer />
            </div>
          </div>
        </main>
      </div>
    </ChatControllerContext.Provider>
  );
}

const NO_PROMPTS: string[] = [];

/**
 * The chat's draft/session controller. With no session open (or after "New session") the chat is
 * a draft: the first prompt creates a session with the chosen runtime, opens it, then sends.
 */
function useChatSession(defaultRuntime: string | undefined, starterPrompts: string[]) {
  const store = useUncageStore();
  const { activeSessionId, create, select } = useSessions();
  const { runtimes } = useRuntimes();
  const { send } = useRun();
  const [newSession, setDraft] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const creating = useRef(false);
  const draft = newSession || activeSessionId === undefined;
  const runtimeId = pickRuntime(runtimes, chosen ?? defaultRuntime);

  const value = useMemo<ChatController>(
    () => ({
      draft,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      setRuntimeId: setChosen,
      starterPrompts,
      async send(text) {
        if (!draft) return send(text);
        if (runtimeId === undefined || creating.current) return;
        creating.current = true;
        try {
          const id = await create({ runtime: runtimeId });
          setDraft(false);
          await select(id);
          await store.actions.sendPrompt(text);
        } catch {
          // createSession failures are recorded in the store's lastError (shown by ConnectionBanner).
        } finally {
          creating.current = false;
        }
      },
    }),
    [draft, runtimeId, starterPrompts, send, create, select, store],
  );
  return { value, setDraft };
}

/**
 * The default Uncage chat: session sidebar, conversation column (max 720px) and a pinned
 * composer, styled after Kumi. Import `@uncage/react-ui/styles.css` once. Must be rendered inside
 * `<UncageProvider>`.
 */
export function AgentChat({
  locale = 'en',
  theme = 'light',
  sidebar = true,
  defaultRuntime,
  starterPrompts,
  showTools = true,
  components,
  className,
}: AgentChatProps): JSX.Element {
  return (
    <UncageUIProvider locale={locale} showTools={showTools} {...(components ? { components } : {})}>
      <ChatLayout
        sidebar={sidebar}
        theme={theme}
        starterPrompts={starterPrompts ?? NO_PROMPTS}
        {...(defaultRuntime !== undefined ? { defaultRuntime } : {})}
        {...(className !== undefined ? { className } : {})}
      />
    </UncageUIProvider>
  );
}
