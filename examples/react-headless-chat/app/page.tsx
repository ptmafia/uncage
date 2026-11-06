'use client';

import { UncageProvider } from '@uncage/react';
import { Chat } from './Chat';

export default function Page() {
  return (
    <UncageProvider>
      <Chat />
    </UncageProvider>
  );
}
