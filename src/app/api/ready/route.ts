import { handleReadiness } from '@/lib/tour27/handlers';

export const dynamic = 'force-dynamic';

/** Readiness probe (configuration present). Distinct from /api/health, which is process liveness. */
export async function GET() {
  return handleReadiness((name) => process.env[name]);
}
