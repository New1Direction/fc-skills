import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'fc-skills — Onchain research docs', template: '%s | fc-skills' },
  description: 'The field manual for 16 crypto research, Robinhood Chain data, and execution-simulation skills.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body className="flex min-h-screen flex-col"><Provider>{children}</Provider></body></html>;
}
