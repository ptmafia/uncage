import { createUncageClient, type UncageClient } from '@uncage/client';
import { createContext, useState, type JSX, type ReactNode } from 'react';
import { createUncageStore, type UncageStore } from './store.js';

export const UncageStoreContext = createContext<UncageStore | null>(null);

export interface UncageProviderProps {
  /** A ready client; takes precedence over `baseUrl`. */
  client?: UncageClient;
  /** Base URL for a default client (defaults to the client's `/api/uncage`). */
  baseUrl?: string;
  children: ReactNode;
}

/** Creates one store for the lifetime of the provider (later prop changes are ignored). */
export function UncageProvider({ client, baseUrl, children }: UncageProviderProps): JSX.Element {
  const [store] = useState(() =>
    createUncageStore(client ?? createUncageClient(baseUrl !== undefined ? { baseUrl } : {})),
  );
  return <UncageStoreContext.Provider value={store}>{children}</UncageStoreContext.Provider>;
}
