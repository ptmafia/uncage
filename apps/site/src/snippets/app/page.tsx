'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <UncageProvider baseUrl="/api/uncage">
      {/* Offers “Connect your computer” first */}
      <AgentChat starterPrompts={['Build a launch page']} />
    </UncageProvider>
  );
}
