'use client';

import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

// <AgentChat> keeps the open session in `?session=<id>`, so a reload reopens the conversation.
export default function Page() {
  return (
    <UncageProvider>
      <AgentChat locale="zh-CN" />
    </UncageProvider>
  );
}
