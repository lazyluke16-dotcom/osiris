import { DestinationIntelligenceGateway, type GatewayProviders } from './gateway';
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

export function buildDefaultProviders(_deps: ProviderDeps): GatewayProviders {
  // Provider ports are registered here as they land (each with its own test suite).
  return {};
}

let singleton: DestinationIntelligenceGateway | null = null;

export function getGateway(): DestinationIntelligenceGateway {
  if (!singleton) {
    const deps = buildDefaultDeps();
    singleton = new DestinationIntelligenceGateway(buildDefaultProviders(deps), deps.logger);
  }
  return singleton;
}
