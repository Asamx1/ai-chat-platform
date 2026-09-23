'use client';

export default function StopButton({
  runId,
  onStop,
  disabled,
}: {
  runId: string | null;
  onStop: () => void;
  disabled?: boolean;
}) {
  if (!runId) return null;
  return (
    <button
      type="button"
      className="btn"
      disabled={disabled}
      onClick={async () => {
        // POST /api/chat/stop {runId}
        await fetch('/api/chat/stop', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        onStop();
      }}
    >
      停止
    </button>
  );
}
