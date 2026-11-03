import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

/** Process liveness only: deliberately independent of databases and external services. */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200, headers: noCacheHeaders });
}
