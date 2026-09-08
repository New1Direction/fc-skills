import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/layouts/docs/page';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { getMDXComponents } from '@/components/mdx';

export default function Home() {
  const page = source.getPage([])!;
  const MDX = page.data.body;
  return <DocsLayout tree={source.pageTree} {...baseOptions()}><DocsPage toc={page.data.toc}>
    <div className="msk-page-label">ROBINHOOD CHAIN</div>
    <DocsTitle>{page.data.title}</DocsTitle>
    <DocsDescription>{page.data.description}</DocsDescription>
    <DocsBody><MDX components={getMDXComponents()} /></DocsBody>
  </DocsPage></DocsLayout>;
}
