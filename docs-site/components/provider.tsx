'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import SearchDialog from './search';
import type { ReactNode } from 'react';

export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider theme={{ defaultTheme: 'dark' }} search={{ SearchDialog }}>{children}</RootProvider>;
}
