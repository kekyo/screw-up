// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createNodeModuleKindResolver,
  injectCjsInteropFlag,
  transformDefaultImports,
} from '../src/default-import-fix';

const cjsInteropGlobalFlagPrefix = '__screwUpIsInCJS_';

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

const extractResolveDefaultExport = (
  ts: typeof import('typescript'),
  code: string
): string => {
  const sourceFile = ts.createSourceFile(
    'helper.ts',
    code,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TS
  );
  let helper: string | undefined;
  sourceFile.forEachChild((node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === '__resolveDefaultExport'
    ) {
      helper = node.getText(sourceFile);
    }
  });
  if (!helper) {
    throw new Error('resolve default export helper not found');
  }
  return helper;
};

const extractCjsInteropFlagId = (source: string): string => {
  const match = source.match(
    new RegExp(`\\b${cjsInteropGlobalFlagPrefix}([0-9a-f]+)\\b`)
  );
  if (!match) {
    throw new Error('CJS interop flag not found in helper source');
  }
  return match[1];
};

const createNamespaceObject = (value: unknown) => {
  const namespace: Record<string, unknown> = Object.create(null);
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
  Object.defineProperty(namespace, 'default', { enumerable: true, value });
  return Object.freeze(namespace);
};

const compileResolveDefaultExport = async (
  source: string
): Promise<(module: unknown, isESM: boolean) => unknown> => {
  const ts = await import('typescript');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return new Function(`${compiled}\nreturn __resolveDefaultExport;`)() as (
    module: unknown,
    isESM: boolean
  ) => unknown;
};

const buildResolveDefaultExportPair = async (): Promise<{
  esm: (module: unknown, isESM: boolean) => unknown;
  cjs: (module: unknown, isESM: boolean) => unknown;
}> => {
  const root = createTempRoot();
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  const importer = join(srcDir, 'index.ts');

  writePackage(root, 'pkg-cjs', {
    main: 'index.js',
  });

  const code = ["import Foo from 'pkg-cjs';", 'console.log(Foo);'].join('\n');

  const ts = await import('typescript');
  const resolveKind = createNodeModuleKindResolver();
  const result = await transformDefaultImports(ts, code, importer, resolveKind);
  if (!result.changed) {
    throw new Error('helper was not injected');
  }

  const esmHelper = extractResolveDefaultExport(ts, result.code);
  const helperId = extractCjsInteropFlagId(esmHelper);
  const flagName = `${cjsInteropGlobalFlagPrefix}${helperId}`;
  const helper = await compileResolveDefaultExport(esmHelper);
  const globalRef = globalThis as Record<string, unknown>;
  const withFlag =
    (flagValue: boolean) =>
    (moduleValue: unknown, isESM: boolean): unknown => {
      const previous = globalRef[flagName];
      globalRef[flagName] = flagValue;
      try {
        return helper(moduleValue, isESM);
      } finally {
        if (previous === undefined) {
          delete globalRef[flagName];
        } else {
          globalRef[flagName] = previous;
        }
      }
    };

  return {
    esm: withFlag(false),
    cjs: withFlag(true),
  };
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

  it('transforms default imports for cjs and esm targets', async () => {
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
    const helperMatch = result.code.match(
      new RegExp(`\\b${cjsInteropGlobalFlagPrefix}([0-9a-f]+)\\b`)
    );
    expect(helperMatch).not.toBeNull();
    const helperId = helperMatch ? helperMatch[1] : '';
    expect(result.code).toContain(
      `globalThis.${cjsInteropGlobalFlagPrefix}${helperId} = false;`
    );
    expect(result.code).toContain('if (__isInCJS)');
    expect(result.code).toContain(
      "import * as __screwUpDefaultImportModule0 from 'pkg-cjs';"
    );
    expect(result.code).toContain("import { baz } from 'pkg-cjs';");
    expect(result.code).toContain(
      'const Foo = __resolveDefaultExport(__screwUpDefaultImportModule0, false);'
    );
    expect(result.code).toContain(
      'const Bar = __resolveDefaultExport(__screwUpDefaultImportModule1, false);'
    );
    expect(result.code).toContain(
      "import * as __screwUpDefaultImportModule2 from 'pkg-esm';"
    );
    expect(result.code).toContain(
      'const ESMDefault = __resolveDefaultExport(__screwUpDefaultImportModule2, true);'
    );
    expect(result.code).toContain("import type TypeOnly from 'pkg-cjs';");
    expect(result.code).toContain(
      "import Unresolvable from 'pkg-require-only';"
    );
    expect(result.code).not.toContain("import Foo from 'pkg-cjs';");
    expect(result.code).not.toContain("import Bar, { baz } from 'pkg-cjs';");
    expect(result.code).not.toContain("import ESMDefault from 'pkg-esm';");
  });

  it('injects the cjs interop flag for cjs outputs', () => {
    const helperId = 'deadbeefcafe';
    const code = [
      `globalThis.${cjsInteropGlobalFlagPrefix}${helperId} = false;`,
      'function __resolveDefaultExport(module, isESM) {',
      `  const __isInCJS = globalThis.${cjsInteropGlobalFlagPrefix}${helperId} === true;`,
      '  if (__isInCJS) {',
      '    return module.default ?? module;',
      '  }',
      '  return module;',
      '}',
      'var untouched = false;',
    ].join('\n');

    const result = injectCjsInteropFlag(code);

    expect(result.changed).toBe(true);
    expect(result.code).toContain(
      `globalThis.${cjsInteropGlobalFlagPrefix}${helperId} = true ;`
    );
    expect(result.code).toContain('var untouched = false;');
  });
});

describe('default import fix combination behavior', () => {
  let resolveESMOutput: (module: unknown, isESM: boolean) => unknown;
  let resolveCJSOutput: (module: unknown, isESM: boolean) => unknown;

  beforeAll(async () => {
    const helpers = await buildResolveDefaultExportPair();
    resolveESMOutput = helpers.esm;
    resolveCJSOutput = helpers.cjs;
  });

  it('handles ESM output with CJS dependencies', () => {
    const moduleValue = { named: 'value' };
    const resolved = resolveESMOutput(moduleValue, false);
    expect(resolved).toBe(moduleValue);
  });

  it('handles ESM output with ESM dependencies', () => {
    const moduleValue = { default: 'esm-default' };
    expect(resolveESMOutput(moduleValue, true)).toBe('esm-default');
    expect(() => resolveESMOutput({ named: 'value' }, true)).toThrow(
      'Default export not found.'
    );
  });

  it('handles CJS output with CJS dependencies', () => {
    const moduleValue = { default: 'cjs-default' };
    expect(resolveCJSOutput(moduleValue, false)).toBe('cjs-default');
    const noDefault = { named: 'value' };
    expect(resolveCJSOutput(noDefault, false)).toBe(noDefault);
  });

  it('handles CJS output with ESM dependencies', () => {
    const noDefault = { named: 'value' };
    expect(resolveCJSOutput(noDefault, true)).toBe(noDefault);
  });

  it('unwraps interop namespace defaults in CJS output', () => {
    const innerDefault = { value: 'esm-default' };
    const innerNamespace = createNamespaceObject(innerDefault);
    const outerNamespace = createNamespaceObject(innerNamespace);
    expect(resolveCJSOutput(outerNamespace, true)).toBe(innerDefault);
  });
});
