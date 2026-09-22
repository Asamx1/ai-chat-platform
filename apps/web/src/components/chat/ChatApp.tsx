'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationList from '@/components/chat/ConversationList';
import MessageStream from '@/components/chat/MessageStream';
import Composer from '@/components/chat/Composer';
import ModelPicker, { getStoredModel } from '@/components/chat/ModelPicker';
import CollabLauncher from '@/components/collab/CollabLauncher';
import KbMountPicker from '@/components/kb/KbMountPicker';
import OrchestrationProgress from '@/components/collab/OrchestrationProgress';
import RunTimeline from '@/components/runs/RunTimeline';
import { parseCitations } from '@/lib/citation-metadata';
import type { ChatMessage, MessageStatus } from '@/components/chat/types';

import { applyRunEvent, sendFailure, shouldCloseRunStream, type RunEvent } from './chat-events';

/** sessionStorage 缓存 key：conv:{id} */
const cacheKey = (convId: string) => `conv:${convId}`;

function loadCache(convId: string): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(cacheKey(convId));
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export default function ChatApp({ isAdmin = false }: { isAdmin?: boolean }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modelKey, setModelKey] = useState(getStoredModel());
  const [runId, setRunId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [listRefresh, setListRefresh] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // 协作运行侧栏：进度视图与事件详情
  const [collabRunId, setCollabRunId] = useState<string | null>(null);
  const newConversationRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // 当前流式 assistant 消息 id 与待重试的 idempotencyKey
  const assistantIdRef = useRef<string | null>(null);

  const persist = useCallback((convId: string, msgs: ChatMessage[]) => {
    try {
      sessionStorage.setItem(cacheKey(convId), JSON.stringify(msgs));
    } catch {
      /* 存储满/不可用时静默降级为仅内存 */
    }
  }, []);

  // 切换会话：先显示本地缓存，再拉服务端历史覆盖（M1.5 已接历史接口）
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    // The send callback already owns the new conversation's live messages.
    // A history request here can overwrite its assistant bubble before completion.
    if (newConversationRef.current === activeId) {
      newConversationRef.current = null;
      return;
    }
    setMessages(loadCache(activeId));
    let cancelled = false;
    fetch(`/api/conversations/${activeId}/messages?limit=100`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.items) return;
        setMessages(
          data.items.map((m: { id: string; role: 'user' | 'assistant'; content: string; status?: string; citations?: unknown }) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            citations: parseCitations(m.citations),
            status: (m.status?.toLowerCase() ?? 'succeeded') as MessageStatus,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // 组件卸载时关流
  useEffect(() => () => esRef.current?.close(), []);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    assistantIdRef.current = null;
    setRunId(null);
  }, []);

  const send = useCallback(
    async (content: string, idempotencyKey: string) => {
      let convId = activeId;
      setSending(true);
      setNotice(null);
      try {
        // ① POST /api/chat/send {conversationId?,content,modelKey,idempotencyKey}
        //    → {conversationId,messageId,runId}
        const res = await fetch('/api/chat/send', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(convId ? { conversationId: convId } : {}),
            content,
            modelKey,
            idempotencyKey,
          }),
        });
        if (!res.ok) throw new Error(await sendFailure(res));
        const { conversationId, runId: rid } = (await res.json()) as {
          conversationId: string;
          messageId?: string;
          runId: string;
        };
        convId = conversationId;
        if (!activeId) {
          newConversationRef.current = conversationId;
          setActiveId(conversationId);
          setListRefresh((k) => k + 1);
        }

        // 乐观 user 气泡 + 初始 assistant 气泡（本地累积，缓存于 sessionStorage）
        const userId = `local-${idempotencyKey}`;
        const assistantId = `assistant-${rid}`;
        assistantIdRef.current = assistantId;
        setMessages((prev) => {
          // 重试时去掉旧的失败 assistant 气泡
          const base = prev.filter((m) => m.retryIdempotencyKey !== idempotencyKey || m.role !== 'assistant');
          const next: ChatMessage[] = [
            ...base.filter((m) => m.id !== userId),
            { id: userId, role: 'user', content },
            { id: assistantId, role: 'assistant', content: '', status: 'streaming' },
          ];
          persist(conversationId, next);
          return next;
        });
        setRunId(rid);

        // ② EventSource 订阅 GET /api/runs/[runId]/events
        //    断线浏览器自动重连并携带 Last-Event-ID（服务端 15s 心跳）
        const es = new EventSource(`/api/runs/${rid}/events`);
        esRef.current = es;
        es.onmessage = (ev: MessageEvent<string>) => {
          let evt: RunEvent;
          try {
            evt = JSON.parse(ev.data) as RunEvent;
          } catch {
            return;
          }
          setMessages((prev) => {
            const next = prev.map((m) => {
              if (m.id !== assistantId) return m;
              return applyRunEvent(m, evt, idempotencyKey);
            });
            persist(conversationId as string, next);
            return next;
          });
          if (shouldCloseRunStream(evt)) {
            closeStream();
            setSending(false);
          }
        };
        es.onopen = () => setNotice(null);
        es.onerror = () => {
          setNotice('消息流连接中断，正在尝试重连；可停止后重试。');
          if (es.readyState === EventSource.CLOSED) {
            closeStream();
            setSending(false);
          }
        };
      } catch (e) {
        setSending(false);
        closeStream();
        setNotice(e instanceof Error ? e.message : '发送失败');
      }
    },
    [activeId, modelKey, persist, closeStream],
  );

  const handleSend = useCallback(
    (content: string) => {
      // idempotencyKey：一次用户输入生成一次；重试复用同一个 key
      void send(content, crypto.randomUUID());
    },
    [send],
  );

  const handleRetry = useCallback(
    (idempotencyKey: string) => {
      // 重试：从缓存中找回该 key 对应的用户消息原文
      const userMsg = messages.find((m) => m.id === `local-${idempotencyKey}`);
      if (userMsg) void send(userMsg.content, idempotencyKey);
    },
    [messages, send],
  );

  const handleStop = useCallback(() => {
    // StopButton 已 POST /api/chat/stop；本地立即标记为已停止并关流
    // （若服务端随后推送 run.cancelled，上方 onmessage 也会兜底处理）
    const aid = assistantIdRef.current;
    if (aid) {
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === aid ? { ...m, status: 'cancelled' as MessageStatus } : m));
        if (activeId) persist(activeId, next);
        return next;
      });
    }
    closeStream();
    setSending(false);
  }, [activeId, persist, closeStream]);

  return (
    <div className="app-shell">
      <ConversationList
        activeId={activeId}
        onSelect={setActiveId}
        refreshKey={listRefresh}
      />
      <div className="chat-main">
        <div className="chat-topbar">
          <span>{activeId ? '对话' : '新对话'}</span>
          <div className="topbar-actions">
            {isAdmin && <a className="topbar-link" href="/admin">后台</a>}
            <a className="topbar-link" href="/kb">
              知识库
            </a>
            <a className="topbar-link" href="/settings">
              设置
            </a>
            <CollabLauncher conversationId={activeId} onLaunched={setCollabRunId} />
            <ModelPicker value={modelKey} onChange={setModelKey} disabled={sending} />
            <KbMountPicker conversationId={activeId} />
          </div>
        </div>
        {notice && <div role="alert" className="msg-status failed" style={{ padding: '8px 16px' }}>{notice}</div>}
        <MessageStream messages={messages} onRetry={handleRetry} />
        <Composer
          disabled={sending}
          streaming={sending}
          runId={runId}
          onSend={handleSend}
          onStop={handleStop}
        />
      </div>
      {collabRunId && (
        <div className="collab-side">
          <button type="button" className="tl-btn" onClick={() => setCollabRunId(null)}>关闭协作进度</button>
          <OrchestrationProgress key={collabRunId} runId={collabRunId} />
          <RunTimeline runId={collabRunId} collapsed />
        </div>
      )}
    </div>
  );
}
