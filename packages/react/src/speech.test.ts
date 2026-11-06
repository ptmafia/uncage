import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSpeechInput } from './speech.js';

/** A minimal SpeechRecognition stand-in driven by the test. */
class FakeRecognizer {
  static last: FakeRecognizer | undefined;
  lang = '';
  interimResults = false;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognizer.last = this;
  }
  /** Emits results; each entry is [transcript, isFinal]. */
  emit(resultIndex: number, results: Array<[string, boolean]>) {
    const list = results.map(([transcript, isFinal]) => Object.assign([{ transcript, confidence: 1 }], { isFinal }));
    this.onresult?.({ resultIndex, results: list });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeRecognizer.last = undefined;
});

describe('useSpeechInput', () => {
  it('supported=false without the API; start is a no-op', () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ lang: 'en-US', onText }));
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(result.current.listening).toBe(false);
  });

  it('with a fake recognizer emits interim then final text', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognizer);
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ lang: 'zh-CN', onText }));
    expect(result.current.supported).toBe(true);
    act(() => result.current.start());
    const rec = FakeRecognizer.last!;
    expect(rec).toMatchObject({ lang: 'zh-CN', interimResults: true, continuous: true });
    expect(rec.start).toHaveBeenCalled();
    expect(result.current.listening).toBe(true);

    act(() => rec.emit(0, [['hel', false]]));
    act(() => rec.emit(0, [['hello world', true]]));
    act(() => rec.emit(1, [['hello world', true], ['again', false]]));
    expect(onText.mock.calls).toEqual([
      ['hel', false],
      ['hello world', true],
      ['again', false],
    ]);
    act(() => result.current.stop());
    expect(rec.stop).toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
  });

  it('prefers the standard constructor and maps errors', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognizer);
    const { result } = renderHook(() => useSpeechInput({ lang: 'en-US', onText: () => {} }));
    for (const code of ['not-allowed', 'no-speech', 'network']) {
      act(() => result.current.start());
      act(() => {
        FakeRecognizer.last!.onerror?.({ error: code });
        FakeRecognizer.last!.onend?.();
      });
      expect(result.current.error).toBe(code);
      expect(result.current.listening).toBe(false);
    }
    act(() => result.current.start());
    expect(result.current.error).toBeUndefined();
  });

  it('stops on unmount', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognizer);
    const onText = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechInput({ lang: 'en-US', onText }));
    act(() => result.current.start());
    const rec = FakeRecognizer.last!;
    unmount();
    expect(rec.abort).toHaveBeenCalled();
    rec.emit(0, [['late', true]]);
    expect(onText).not.toHaveBeenCalled();
  });
});
