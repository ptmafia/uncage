import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/** The subset of the Web Speech API `SpeechRecognition` used here. */
interface Recognizer {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
type RecognizerCtor = new () => Recognizer;

/** `window.SpeechRecognition ?? window.webkitSpeechRecognition`, or undefined (also during SSR). */
function recognizerCtor(): RecognizerCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const noSubscribe = () => () => {};
const isSupported = () => recognizerCtor() !== undefined;
const notSupported = () => false;

/**
 * Dictation via the browser's Web Speech API (`interimResults`, `continuous`). `onText` receives
 * interim text (`final: false`, replaced by later interim/final text) and final text (`final: true`).
 * `error` is the recognizer's error code (e.g. `not-allowed`, `no-speech`, `network`). Recognition
 * is aborted on unmount. `supported` is false during SSR and without the API.
 */
export function useSpeechInput(o: { lang: string; onText(text: string, final: boolean): void }): {
  supported: boolean;
  listening: boolean;
  start(): void;
  stop(): void;
  error?: string;
} {
  const supported = useSyncExternalStore(noSubscribe, isSupported, notSupported);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const recognizer = useRef<Recognizer | null>(null);
  const latest = useRef(o);
  useEffect(() => {
    latest.current = o;
  });

  const start = useCallback(() => {
    const Ctor = recognizerCtor();
    if (!Ctor || recognizer.current) return;
    const rec = new Ctor();
    rec.lang = latest.current.lang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      if (recognizer.current !== rec) return;
      let finalText = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (finalText) latest.current.onText(finalText, true);
      if (interim) latest.current.onText(interim, false);
    };
    rec.onerror = (e) => {
      if (recognizer.current === rec) setError(e.error || 'unknown');
    };
    rec.onend = () => {
      if (recognizer.current !== rec) return;
      recognizer.current = null;
      setListening(false);
    };
    recognizer.current = rec;
    setError(undefined);
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      recognizer.current = null;
      setError(err instanceof Error && err.name ? err.name : 'unknown');
    }
  }, []);

  const stop = useCallback(() => {
    recognizer.current?.stop();
  }, []);

  useEffect(
    () => () => {
      const rec = recognizer.current;
      recognizer.current = null;
      rec?.abort();
    },
    [],
  );

  return useMemo(
    () => ({ supported, listening, start, stop, ...(error !== undefined ? { error } : {}) }),
    [supported, listening, start, stop, error],
  );
}
