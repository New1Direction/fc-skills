import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'fc-skills — Docs', template: '%s | fc-skills' },
  description: 'Simple guides to researching tokens, checking liquidity, and monitoring Robinhood Chain with your AI agent.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body className="flex min-h-screen flex-col"><Provider>{children}</Provider></body></html>;
}
