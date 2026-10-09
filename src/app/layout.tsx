import type { Metadata, Viewport } from 'next';
import './globals.css';
import { CommandBar } from '@/ui/shell/CommandBar';
import { StatusBar } from '@/ui/shell/StatusBar';
import { SessionBar } from '@/ui/shell/SessionBar';
import { t, DEFAULT_LOCALE, LOCALE_DIRECTION } from '@/platform/i18n';

export const metadata: Metadata = {
  title: `${t('app.name')} — ${t('app.tagline')}`,
  description: t('app.tagline'),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Direction comes from the locale, not from a hardcoded attribute, so Arabic
  // and other right-to-left languages need no layout changes (R-19, §19.4).
  const direction = LOCALE_DIRECTION[DEFAULT_LOCALE];

  return (
    <html lang={DEFAULT_LOCALE} dir={direction}>
      <body>
        <div className="ledger-frame">
          <CommandBar />
          <SessionBar />
          <main className="flex-1">{children}</main>
          <StatusBar />
        </div>
      </body>
    </html>
  );
}
