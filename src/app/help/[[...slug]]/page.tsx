import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireSession } from '@/platform/auth/current';
import { HELP_ROUTE, loadHelpPage } from '@/modules/platform/help-docs';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug?: string[] }>;

export async function generateMetadata({ params }: { params: Params }) {
  const page = loadHelpPage((await params).slug ?? []);
  return { title: page ? `${page.title} — User guide` : 'User guide' };
}

export default async function HelpPage({ params }: { params: Params }) {
  const slug = (await params).slug ?? [];
  await requireSession(`${HELP_ROUTE}${slug.length ? '/' + slug.join('/') : ''}`);
  const page = loadHelpPage(slug);
  if (!page) notFound();
  return (
    <Page
      title="User guide" width="5xl"
      actions={slug.length > 0 ? <Link href={HELP_ROUTE} className="btn btn-default">Guide index</Link> : undefined}
    >
      <article className="help-doc panel p-4 md:p-6" dangerouslySetInnerHTML={{ __html: page.html }} />
    </Page>
  );
}
