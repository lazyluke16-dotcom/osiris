import { getGateway } from '@/lib/tour27/default-gateway';
import { handleProviderHealth } from '@/lib/tour27/handlers';

export const dynamic = 'force-dynamic';

/** Provider health (registry snapshot). Protected by the service token in gateway mode. */
export async function GET() {
  return handleProviderHealth(getGateway());
}
