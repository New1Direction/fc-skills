import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <span className="msk-wordmark"><span className="msk-mark">M</span><strong>MSK</strong><span className="msk-label">FIELD MANUAL</span></span>, url: '/' },
    githubUrl: 'https://github.com/New1Direction/MSK',
    links: [{ text: 'v0.8.0', url: '/docs/reference/releases/' }],
  };
}
