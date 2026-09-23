'use client';

import { useState, type KeyboardEvent } from 'react';
import StopButton from './StopButton';

export default function Composer({
  disabled,
  streaming,
  runId,
  onSend,
  onStop,
}: {
  disabled?: boolean;
  streaming?: boolean;
  runId: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const content = text.trim();
    if (!content || disabled) return;
    onSend(content);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea className="input"
        rows={1}
        value={text}
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {streaming ? (
        <StopButton runId={runId} onStop={onStop} />
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !text.trim()}
          onClick={submit}
        >
          发送
        </button>
      )}
    </div>
  );
}
