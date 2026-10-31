import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the hexagonal boundaries agreed in docs/architecture/arquitectura.md:
 * dependencies always point towards the core, and the core knows no infrastructure.
 */
const SRC = resolve(__dirname, '..', 'src');

type Layer = 'domain' | 'ports' | 'application';

const ALLOWED_LAYERS: Record<Layer, readonly string[]> = {
  domain: ['domain'],
  ports: ['domain', 'ports'],
  application: ['domain', 'ports', 'application'],
};

// Packages that only adapters and the composition root may use.
const INFRASTRUCTURE_PACKAGES = [
  /^@nestjs\//,
  /^fastify/,
  /^@fastify\//,
  /^typeorm/,
  /^pg$/,
  /^node:(fs|http|https|net|child_process)/,
];

const IMPORT_PATTERN = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  return [...code.matchAll(IMPORT_PATTERN)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function layerOf(absolutePath: string): string | undefined {
  return relative(SRC, absolutePath).split(sep)[0];
}

function violations(layer: Layer): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(join(SRC, layer))) {
    for (const specifier of importsOf(file)) {
      const where = `${relative(SRC, file)} → ${specifier}`;
      if (specifier.startsWith('.')) {
        const target = layerOf(resolve(file, '..', specifier));
        if (!target || !ALLOWED_LAYERS[layer].includes(target)) found.push(where);
      } else if (INFRASTRUCTURE_PACKAGES.some((p) => p.test(specifier))) {
        found.push(where);
      }
    }
  }
  return found;
}

describe('hexagonal boundaries', () => {
  for (const layer of Object.keys(ALLOWED_LAYERS) as Layer[]) {
    it(`${layer} imports only from ${ALLOWED_LAYERS[layer].join(', ')} and no infrastructure`, () => {
      expect(violations(layer)).toEqual([]);
    });
  }
});
