// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { describe, expect, it } from 'vitest';
import { encode } from '@jridgewell/sourcemap-codec';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  adjustSourceMapForDeclarationEdits,
  fixDeclarationImportSpecifiers,
} from '../src/declaration-import-fix';

const baseDir = join(tmpdir(), 'screw-up-declaration-import-fix');

describe('declaration import fix', () => {
  it('rewrites relative declaration imports to NodeNext-compatible runtime suffixes', async () => {
    const importer = join(baseDir, 'dist', 'index.d.ts');
    const declarationFiles = new Set([
      join(baseDir, 'dist', 'types.d.ts'),
      join(baseDir, 'dist', 'nested', 'index.d.ts'),
      join(baseDir, 'dist', 'esm.d.mts'),
      join(baseDir, 'dist', 'cjs.d.cts'),
    ]);
    const code = [
      "export { Foo } from './types';",
      "export { Bar } from './nested';",
      "export type Baz = import('./esm').Baz;",
      "export type Qux = import('./cjs').Qux;",
      "export type Keep = import('pkg').Keep;",
      "export { Ready } from './ready.js';",
    ].join('\n');

    const ts = await import('typescript');
    const result = fixDeclarationImportSpecifiers(
      ts,
      code,
      importer,
      declarationFiles
    );

    expect(result.changed).toBe(true);
    expect(result.code).toBe(
      [
        "export { Foo } from './types.js';",
        "export { Bar } from './nested/index.js';",
        "export type Baz = import('./esm.mjs').Baz;",
        "export type Qux = import('./cjs.cjs').Qux;",
        "export type Keep = import('pkg').Keep;",
        "export { Ready } from './ready.js';",
      ].join('\n')
    );
  });

  it('preserves exact mixed newline sequences during declaration import fixes', async () => {
    const importer = join(baseDir, 'dist', 'index.d.ts');
    const declarationFiles = new Set([
      join(baseDir, 'dist', 'types.d.ts'),
      join(baseDir, 'dist', 'nested', 'index.d.ts'),
    ]);
    const crlf = '\r\n';
    const lf = '\n';
    const code =
      "export { Foo } from './types';" +
      crlf +
      "export type Bar = import('./nested').Bar;" +
      lf +
      "export { Ready } from './ready.js';" +
      crlf;
    const expected =
      "export { Foo } from './types.js';" +
      crlf +
      "export type Bar = import('./nested/index.js').Bar;" +
      lf +
      "export { Ready } from './ready.js';" +
      crlf;

    const ts = await import('typescript');
    const result = fixDeclarationImportSpecifiers(
      ts,
      code,
      importer,
      declarationFiles
    );

    expect(result.changed).toBe(true);
    expect(Buffer.from(result.code, 'utf-8')).toEqual(
      Buffer.from(expected, 'utf-8')
    );
  });

  it('adjusts declaration source maps after suffix insertions', () => {
    const crlf = '\r\n';
    const lf = '\n';
    const firstLine = "export { Foo } from './types';" + crlf;
    const secondLine =
      "export declare const bar: typeof import('./types').bar;" + lf;
    const code = firstLine + secondLine;
    const firstLineSemicolon = firstLine.indexOf(';');
    const secondLineBar = secondLine.indexOf('.bar');
    const firstInsertion = firstLine.indexOf("';");
    const secondInsertion = firstLine.length + secondLine.indexOf("').");

    const map = {
      version: 3,
      file: 'index.d.ts',
      sources: ['../src/index.ts'],
      names: [],
      mappings: encode([
        [
          [0, 0, 0, 0],
          [firstLineSemicolon, 0, 0, 20],
        ],
        [
          [0, 0, 1, 0],
          [secondLineBar, 0, 1, 25],
        ],
      ]),
    };
    const adjusted = adjustSourceMapForDeclarationEdits(
      `${JSON.stringify(map)}${lf}`,
      code,
      [
        {
          start: firstInsertion,
          end: firstInsertion,
          text: '.js',
        },
        {
          start: secondInsertion,
          end: secondInsertion,
          text: '.js',
        },
      ]
    );

    expect(adjusted).toBeDefined();
    expect(adjusted?.endsWith(lf)).toBe(true);

    const traceMap = new TraceMap(JSON.parse(adjusted!));
    const firstPosition = originalPositionFor(traceMap, {
      line: 1,
      column: firstLineSemicolon + 3,
    });
    const secondPosition = originalPositionFor(traceMap, {
      line: 2,
      column: secondLineBar + 3,
    });

    expect(firstPosition.source).toBe('../src/index.ts');
    expect(firstPosition.line).toBe(1);
    expect(firstPosition.column).toBe(20);
    expect(secondPosition.source).toBe('../src/index.ts');
    expect(secondPosition.line).toBe(2);
    expect(secondPosition.column).toBe(25);
  });
});
