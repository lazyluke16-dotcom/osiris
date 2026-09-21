import { DestinationIntelligenceGateway, type GatewayProviders } from './gateway';
import { createEcccProvider } from './providers/eccc';
import { createEonetProvider } from './providers/eonet';
import { createFirmsProvider } from './providers/firms';
import { createMetnoProvider } from './providers/metno';
import { createNwsProvider } from './providers/nws';
import { createUsgsProvider } from './providers/usgs';
import { consoleLogger, MemoryCache, type ProviderDeps } from './runtime';

/** Real dependencies for the running server. Tests build their own gateway with fakes. */
export function buildDefaultDeps(): ProviderDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    cache: new MemoryCache(),
    now: () => new Date(),
    env: (name) => process.env[name],
    logger: consoleLogger,
  };
}

export function buildDefaultProviders(deps: ProviderDeps): GatewayProviders {
  // Provider ports are registered here as they land (each with its own test suite).
  return {
    usgs: createUsgsProvider(deps),
    firms: createFirmsProvider(deps),
    metno: createMetnoProvider(deps),
    eonet: createEonetProvider(deps),
    nws: createNwsProvider(deps),
    eccc: createEcccProvider(deps),
  };
}

let singleton: DestinationIntelligenceGateway | null = null;

export function getGateway(): DestinationIntelligenceGateway {
  if (!singleton) {
    const deps = buildDefaultDeps();
    singleton = new DestinationIntelligenceGateway(buildDefaultProviders(deps), deps.logger);
  }
  return singleton;
}
