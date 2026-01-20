// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createNodeModuleKindResolver,
  transformDefaultImports,
} from '../src/default-import-fix';

const createTempRoot = () =>
  mkdtempSync(join(tmpdir(), 'screw-up-default-import-'));

const writePackage = (
  root: string,
  name: string,
  packageJson: Record<string, unknown>
) => {
  const packageDir = join(root, 'node_modules', name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
    'utf8'
  );
};

describe('default import fix helpers', () => {
  it('classifies module kinds using node resolution rules', async () => {
    const root = createTempRoot();
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true });
    const importer = join(srcDir, 'index.ts');

    writePackage(root, 'json5-like', {
      main: 'lib/index.js',
      module: 'dist/index.mjs',
    });
    writePackage(root, 'esm-type', {
      type: 'module',
      main: 'index.js',
    });
    writePackage(root, 'exports-import', {
      exports: {
        import: './index.mjs',
      },
    });
    writePackage(root, 'exports-default-cjs', {
      exports: {
        default: './index.js',
      },
    });
    writePackage(root, 'exports-require-only', {
      exports: {
        require: './index.cjs',
      },
    });
    writePackage(root, 'exports-dot', {
      exports: {
        '.': {
          import: './index.mjs',
        },
      },
    });

    const resolveKind = createNodeModuleKindResolver();

    await expect(resolveKind('json5-like', importer)).resolves.toBe('cjs');
    await expect(resolveKind('esm-type', importer)).resolves.toBe('esm');
    await expect(resolveKind('exports-import', importer)).resolves.toBe('esm');
    await expect(resolveKind('exports-default-cjs', importer)).resolves.toBe(
      'cjs'
    );
    await expect(resolveKind('exports-require-only', importer)).resolves.toBe(
      'unresolvable'
    );
    await expect(resolveKind('exports-dot', importer)).resolves.toBe('esm');
  });

  it('transforms default imports only for cjs targets', async () => {
    const root = createTempRoot();
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true });
    const importer = join(srcDir, 'index.ts');

    writePackage(root, 'pkg-cjs', {
      main: 'index.js',
    });
    writePackage(root, 'pkg-esm', {
      type: 'module',
      main: 'index.js',
    });
    writePackage(root, 'pkg-require-only', {
      exports: {
        require: './index.cjs',
      },
    });

    const code = [
      "import Foo from 'pkg-cjs';",
      "import Bar, { baz } from 'pkg-cjs';",
      "import type TypeOnly from 'pkg-cjs';",
      "import ESMDefault from 'pkg-esm';",
      "import Unresolvable from 'pkg-require-only';",
      'console.log(Foo, Bar, baz, TypeOnly, ESMDefault, Unresolvable);',
    ].join('\n');

    const ts = await import('typescript');
    const resolveKind = createNodeModuleKindResolver();
    const result = await transformDefaultImports(
      ts,
      code,
      importer,
      resolveKind
    );

    expect(result.changed).toBe(true);
    expect(result.code).toContain('function __resolveDefaultExport');
    expect(
      result.code.match(/__resolveDefaultExport/g)?.length
    ).toBeGreaterThan(0);
    expect(result.code).toContain(
      "import * as __screwUpDefaultImportModule0 from 'pkg-cjs';"
    );
    expect(result.code).toContain("import { baz } from 'pkg-cjs';");
    expect(result.code).toContain('const Foo = __resolveDefaultExport(');
    expect(result.code).toContain('const Bar = __resolveDefaultExport(');
    expect(result.code).toContain("import type TypeOnly from 'pkg-cjs';");
    expect(result.code).toContain("import ESMDefault from 'pkg-esm';");
    expect(result.code).toContain(
      "import Unresolvable from 'pkg-require-only';"
    );
    expect(result.code).not.toContain("import Foo from 'pkg-cjs';");
    expect(result.code).not.toContain("import Bar, { baz } from 'pkg-cjs';");
  });
});
