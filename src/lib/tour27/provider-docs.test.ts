import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENT_ASSUMPTION, DEPLOYMENT_NOTES, FRESHNESS, renderProviderDocs } from './provider-docs';
import { PROVIDER_REGISTRY } from './registry';

const DOC = join(process.cwd(), 'docs', 'tour27', 'PROVIDERS.md');

describe('generated provider documentation', () => {
  it('committed docs/tour27/PROVIDERS.md matches the registry (drift test)', () => {
    const generated = renderProviderDocs();
    if (process.env.UPDATE_TOUR27_DOCS === '1') writeFileSync(DOC, generated);
    expect(existsSync(DOC), 'run UPDATE_TOUR27_DOCS=1 npx vitest run src/lib/tour27/provider-docs.test.ts').toBe(true);
    expect(readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
  });

  it('every registry provider has freshness semantics and deployment notes', () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(FRESHNESS[d.provider], d.provider).toBeTruthy();
      expect(DEPLOYMENT_NOTES[d.provider], d.provider).toBeTruthy();
    }
  });

  it('lists every registry provider, secret NAMES only, and marks pending providers as expected states', () => {
    const doc = renderProviderDocs();
    for (const d of PROVIDER_REGISTRY) expect(doc).toContain(`| ${d.provider} |`);
    expect(doc).toContain('LICENCE_PENDING');
    expect(doc).toContain('TOKEN_PENDING');
    expect(doc).toContain('NASA_FIRMS_MAP_KEY');
    expect(doc).toMatch(/expected states, not failures/);
  });

  it('states the single-instance deployment assumption, and the shipped compose file honours it', () => {
    expect(renderProviderDocs()).toContain(DEPLOYMENT_ASSUMPTION);
    const compose = readFileSync(join(process.cwd(), 'deploy', 'tour27', 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/tour27\.scale:\s*single-instance/);
    expect(compose).not.toMatch(/replicas:\s*([2-9]|\d{2,})/);
    expect(compose).not.toMatch(/\bscale:\s*([2-9]|\d{2,})/);
  });
});
