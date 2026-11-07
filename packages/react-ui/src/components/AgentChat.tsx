import {
  isDraft,
  useApprovals,
  useMessages,
  useRun,
  useRuntimes,
  useSession,
  useSessions,
  useStoreSelector,
  usePersistSession,
  useUncageStore,
  type PersistSessionMode,
} from '@uncage/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ChatControllerContext, cx, UncageUIProvider, useUi, type ChatComponents, type ChatController } from '../context.js';
import type { Locale } from '../i18n.js';
import { BypassBanner } from './BypassBanner.js';
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
  /** Sets `data-theme` on the root (default `'auto'`: follows the OS). */
  theme?: 'light' | 'dark' | 'auto';
  /** Show the session sidebar (default `true`). */
  sidebar?: boolean;
  /** Runtime id preselected for new sessions (default: first available). */
  defaultRuntime?: string;
  /** Prompts offered on the empty state. */
  starterPrompts?: string[];
  /** Show tool steps between messages (default `true`). */
  showTools?: boolean;
  /**
   * Where the open session is remembered so a reload reopens it (default `'url'`: `?session=<id>`,
   * kept in sync with `history.replaceState`). `'localStorage'` keeps the URL clean; `false` turns
   * it off (e.g. when the host app routes sessions itself).
   */
  persistSession?: PersistSessionMode;
  /** Replace any of the default building blocks. */
  components?: Partial<ChatComponents>;
  className?: string;
}

/** Keeps a scroll container pinned to the bottom while the user has not scrolled up. */
function useStickToBottom(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    // Re-run whenever content that changes the height changes.
  }, deps);
  return { ref, onScroll };
}

interface LayoutProps {
  sidebar: boolean;
  theme: string;
  className?: string;
  defaultRuntime?: string;
  starterPrompts: string[];
  persistSession: PersistSessionMode;
}

function ChatLayout({ sidebar, theme, className, defaultRuntime, starterPrompts, persistSession }: LayoutProps): JSX.Element {
  const { locale, components } = useUi();
  usePersistSession(persistSession);
  const controller = useChatSession(defaultRuntime, starterPrompts);
  const { draft } = controller.value;
  const { activeSessionId, select } = useSessions();
  const { timeline, messages } = useMessages();
  const { all: approvals } = useApprovals();
  const { run } = useRun();
  // Any content change (new item, streamed text, approval card, run status) keeps the view pinned.
  const scroll = useStickToBottom([timeline, messages, approvals, run, draft]);
  const Composer = components.Composer ?? DefaultComposer;
  const EmptyState = components.EmptyState ?? DefaultEmptyState;

  return (
    <ChatControllerContext.Provider value={controller.value}>
      <div className={cx('uc-root', 'uc-chat', className)} data-theme={theme} lang={locale}>
        {sidebar && (
          <SessionSidebar
            {...(draft ? { activeId: undefined } : activeSessionId !== undefined ? { activeId: activeSessionId } : {})}
            onSelect={(id) => void select(id)}
            onNew={() => controller.value.startNewSession?.()}
          />
        )}
        <main className="uc-main">
          {!draft && <ConversationHeader />}
          <div className="uc-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
            <div className="uc-column">
              <div className="uc-top-banners">
                <BypassBanner />
                <ConnectionBanner />
              </div>
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
 * The chat's draft/session controller, over the store's draft. With no session open (or after
 * "New session") the chat is a draft on the chosen runtime: settings and files picked in the
 * composer stay in the draft; the first prompt commits it (creates the session and applies them),
 * opens the new session, then sends. The composer stays disabled until the session is open.
 */
function useChatSession(defaultRuntime: string | undefined, starterPrompts: string[]) {
  const store = useUncageStore();
  const { select } = useSessions();
  const { runtimes } = useRuntimes();
  const { session } = useSession();
  const { send } = useRun();
  const draft = useStoreSelector(isDraft);
  const draftRuntime = useStoreSelector((s) => s.draft.runtimeId);
  const [chosen, setChosen] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const busy = useRef(false);
  const preferred = pickRuntime(runtimes, chosen ?? defaultRuntime);
  const draftKnown = draftRuntime !== undefined && runtimes.some((r) => r.id === draftRuntime);
  // A draft uses the runtime chosen for new sessions; an open session always uses its own runtime.
  const runtimeId = draft ? (draftKnown ? draftRuntime : preferred) : session?.runtimeId;

  // Keep the store's draft on a listed runtime, so its capabilities drive the composer. Not while
  // committing: the committed draft is closed but the new session is not open yet, and reopening
  // a draft then would drop the files moving to the new session.
  useEffect(() => {
    if (draft && !committing && !draftKnown && preferred !== undefined) store.actions.openDraft(preferred);
  }, [store, draft, committing, draftKnown, preferred]);

  const value = useMemo<ChatController>(
    () => ({
      draft,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      setRuntimeId(id) {
        setChosen(id);
        store.actions.openDraft(id);
      },
      starterPrompts,
      committing,
      startNewSession: () => store.actions.openDraft(preferred),
      openSession: (id) => void select(id),
      async send(text) {
        if (!draft) return send(text);
        if (runtimeId === undefined || busy.current) return false;
        busy.current = true;
        setCommitting(true);
        try {
          let id: string;
          try {
            id = await store.actions.commitDraft(draftKnown ? {} : { runtime: runtimeId });
          } catch {
            // Recorded in the store's lastError (shown by ConnectionBanner); the draft is kept.
            return false;
          }
          // No input until the new session is open: files added in between would be dropped.
          await select(id);
          setCommitting(false);
          return await store.actions.sendPrompt(text);
        } finally {
          busy.current = false;
          setCommitting(false);
        }
      },
    }),
    [store, draft, draftKnown, runtimeId, preferred, starterPrompts, committing, send, select],
  );
  return { value };
}

/**
 * The default Uncage chat: session sidebar, conversation column (max 720px) and a pinned
 * composer, styled after Kumi. Import `@uncage/react-ui/styles.css` once. Must be rendered inside
 * `<UncageProvider>`.
 */
export function AgentChat({
  locale = 'en',
  theme = 'auto',
  sidebar = true,
  defaultRuntime,
  starterPrompts,
  showTools = true,
  persistSession = 'url',
  components,
  className,
}: AgentChatProps): JSX.Element {
  return (
    <UncageUIProvider locale={locale} showTools={showTools} {...(components ? { components } : {})}>
      <ChatLayout
        sidebar={sidebar}
        theme={theme}
        starterPrompts={starterPrompts ?? NO_PROMPTS}
        persistSession={persistSession}
        {...(defaultRuntime !== undefined ? { defaultRuntime } : {})}
        {...(className !== undefined ? { className } : {})}
      />
    </UncageUIProvider>
  );
}
