import { getGateway } from '@/lib/tour27/default-gateway';
import { handleDestinationIntelligence } from '@/lib/tour27/handlers';

export const dynamic = 'force-dynamic';

/**
 * Tour 27 Destination Intelligence gateway. Service-to-service only: in the `tour27-gateway`
 * deployment mode the middleware requires the service bearer token before this handler runs.
 */
export async function GET(request: Request) {
  return handleDestinationIntelligence(request, getGateway());
}
