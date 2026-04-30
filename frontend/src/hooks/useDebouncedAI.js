/**
 * useDebouncedAI
 *
 * Calls the AI complete endpoint after the user pauses typing. Keeps a
 * single in-flight request — if the user types again before the response
 * arrives, we abort the previous request to avoid stale suggestions.
 */

import { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export function useDebouncedAI({ code, lang, cursorPos, enabled, debounceMs = 600 }) {
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !code) { setSuggestion(''); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // Abort any pending request before kicking a new one.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const res = await fetch(`${API}/ai/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, lang, cursorPos }),
          signal: ac.signal,
        });
        const j = await res.json();
        setSuggestion(j.suggestion || '');
      } catch (e) {
        if (e.name !== 'AbortError') setSuggestion('');
      } finally {
        setLoading(false);
      }
    }, debounceMs);
    return () => clearTimeout(timerRef.current);
  }, [code, lang, cursorPos, enabled, debounceMs]);

  return { suggestion, loading };
}
