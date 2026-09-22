'use client';
import { useState } from 'react';
import UserTable from './UserTable';
import QuotaEditor from './QuotaEditor';
import UsageView from './UsageView';
import ModelRegistryPanel from './ModelRegistryPanel';
import RunsMonitor from './RunsMonitor';
import type { AdminUser } from './api';
export default function AdminConsole({ currentUserId }: { currentUserId: string }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  return <main className="admin-page"><a className="settings-back" href="/">← 返回聊天</a><header className="settings-header"><h1>后台控制台</h1><p>用户、模型注册表、限额、每日用量与运行监控</p></header><UserTable currentUserId={currentUserId} onSelect={setUser} /><QuotaEditor key={user?.id ?? 'none'} user={user} /><UsageView /><ModelRegistryPanel /><RunsMonitor /></main>;
}
