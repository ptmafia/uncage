'use client';

import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

/**
 * The hub is mounted at /api/uncage (UncageProvider's default), so <AgentChat> runs in Connected
 * Mode on its own: with no computer yet it shows <ConnectMachine> (install + `uncage setup <url>`),
 * the header shows which computer a conversation runs on, and with the computer offline the
 * history stays readable (the hub keeps a replica: `sessionStorage: 'site'`).
 */
export function Chat() {
  return (
    <UncageProvider>
      <AgentChat locale="zh-CN" starterPrompts={['做一个介绍 Uncage 的落地页并发布']} />
    </UncageProvider>
  );
}
