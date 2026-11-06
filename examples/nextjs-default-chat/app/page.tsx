'use client';

import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { SessionInUrl } from './session-in-url';

export default function Page() {
  return (
    <UncageProvider>
      <SessionInUrl />
      <AgentChat locale="zh-CN" />
    </UncageProvider>
  );
}
