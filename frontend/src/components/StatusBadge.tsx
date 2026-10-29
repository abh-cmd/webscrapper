type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'neutral';

const TONE_BY_WORD: Record<string, Tone> = {
  connected: 'ok', pass: 'ok', success: 'ok', succeeded: 'ok', completed: 'ok', approved: 'ok',
  operational: 'ok', active: 'ok', healthy: 'ok', stored: 'ok', reused: 'ok', configured: 'ok',
  fail: 'bad', failed: 'bad', error: 'bad', blocked: 'bad', rejected: 'bad', denied: 'bad', dead_letter: 'bad',
  degraded: 'warn', retrying: 'warn', pending: 'warn', running: 'info', processing: 'info',
  awaiting_approval: 'warn', not_configured: 'neutral', mock: 'neutral', unavailable: 'neutral',
  not_available: 'neutral', ejected: 'bad', cooling_down: 'warn'
};

export function toneFor(word: string | undefined | null): Tone {
  if (!word) return 'neutral';
  const key = word.toLowerCase().replace(/\s+/g, '_');
  return TONE_BY_WORD[key] || 'neutral';
}

export function StatusBadge({ label, tone }: { label: string; tone?: Tone }) {
  const resolved = tone || toneFor(label);
  return (
    <span className={`badge ${resolved}`}>
      <span className="dot" />
      {label.replace(/_/g, ' ')}
    </span>
  );
}
