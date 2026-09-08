import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <span className="msk-wordmark"><span className="msk-mark">FC</span><strong>fc-skills</strong><span className="msk-label">DOCS</span></span>, url: '/' },
    githubUrl: 'https://github.com/New1Direction/fc-skills',
    links: [{ text: 'v0.8.0', url: '/docs/reference/releases/' }],
  };
}
