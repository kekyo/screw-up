// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { decode, encode } from '@jridgewell/sourcemap-codec';
import { dirname, join, posix, resolve } from 'path';

import type { Logger } from './internal';
import {
  applyTextEdits,
  collectLineStarts,
  getLineColumnOffset,
  TextEdit,
} from './text-edits';

//////////////////////////////////////////////////////////////////////////////////

const declarationFilePattern = /\.d\.(?:cts|mts|ts)$/;

type DeclarationRuntimeSuffix = '.js' | '.mjs' | '.cjs';

export interface DeclarationImportFixResult {
  readonly changed: boolean;
  readonly code: string;
  readonly edits: readonly TextEdit[];
}

interface SourceMapLike {
  file?: string;
  mappings: string;
  names?: readonly string[];
  sourceRoot?: string;
  sources?: readonly string[];
  sourcesContent?: readonly (string | null)[];
  version: number;
}

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../');

const hasExplicitExtension = (specifier: string): boolean =>
  posix.extname(specifier) !== '';

const getDeclarationRuntimeSuffix = (
  declarationPath: string
): DeclarationRuntimeSuffix => {
  if (declarationPath.endsWith('.d.mts')) {
    return '.mjs';
  }
  if (declarationPath.endsWith('.d.cts')) {
    return '.cjs';
  }
  return '.js';
};

const createCandidateDeclarationPaths = (
  resolvedPath: string
): readonly string[] => [
  `${resolvedPath}.d.ts`,
  `${resolvedPath}.d.mts`,
  `${resolvedPath}.d.cts`,
  join(resolvedPath, 'index.d.ts'),
  join(resolvedPath, 'index.d.mts'),
  join(resolvedPath, 'index.d.cts'),
];

const resolveSpecifierSuffix = (
  specifier: string,
  importerPath: string,
  declarationFiles: ReadonlySet<string>,
  logger?: Logger
): string | undefined => {
  if (!isRelativeSpecifier(specifier) || hasExplicitExtension(specifier)) {
    return undefined;
  }

  const resolvedPath = resolve(dirname(importerPath), specifier);
  const matches = createCandidateDeclarationPaths(resolvedPath).filter((path) =>
    declarationFiles.has(path)
  );

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length >= 2) {
    logger?.warn(
      `[fixDeclarationImports] Skipped ambiguous declaration import: ${specifier} (${matches
        .map((path) => path.split(/[/\\]/).pop() ?? path)
        .join(', ')})`
    );
    return undefined;
  }

  const match = matches[0];
  const runtimeSuffix = getDeclarationRuntimeSuffix(match);
  const indexPrefix = join(resolvedPath, 'index.');

  return match.startsWith(indexPrefix)
    ? `/index${runtimeSuffix}`
    : runtimeSuffix;
};

const collectModuleSpecifierEdits = (
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile,
  importerPath: string,
  declarationFiles: ReadonlySet<string>,
  logger?: Logger
): TextEdit[] => {
  const edits: TextEdit[] = [];
  const seen = new Set<number>();

  const pushSpecifierEdit = (
    literal: import('typescript').StringLiteralLike
  ) => {
    const suffix = resolveSpecifierSuffix(
      literal.text,
      importerPath,
      declarationFiles,
      logger
    );
    if (!suffix) {
      return;
    }

    const insertionPoint = literal.getEnd() - 1;
    if (seen.has(insertionPoint)) {
      return;
    }
    seen.add(insertionPoint);

    edits.push({
      start: insertionPoint,
      end: insertionPoint,
      text: suffix,
    });
  };

  const visit = (node: import('typescript').Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        pushSpecifierEdit(node.moduleSpecifier);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        pushSpecifierEdit(argument.literal);
      }
    }

    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);

  return edits;
};

export const isDeclarationFilePath = (filePath: string): boolean =>
  declarationFilePattern.test(filePath);

export const fixDeclarationImportSpecifiers = (
  ts: typeof import('typescript'),
  code: string,
  filePath: string,
  declarationFiles: ReadonlySet<string>,
  logger?: Logger
): DeclarationImportFixResult => {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TS
  );

  const edits = collectModuleSpecifierEdits(
    ts,
    sourceFile,
    filePath,
    declarationFiles,
    logger
  );

  if (edits.length === 0) {
    return {
      changed: false,
      code,
      edits,
    };
  }

  return {
    changed: true,
    code: applyTextEdits(code, edits),
    edits,
  };
};

export const adjustSourceMapForDeclarationEdits = (
  source: string | Uint8Array,
  originalCode: string,
  edits: readonly TextEdit[]
): string | undefined => {
  if (edits.length === 0) {
    return undefined;
  }

  const original =
    typeof source === 'string' ? source : Buffer.from(source).toString('utf-8');

  let map: SourceMapLike;
  try {
    map = JSON.parse(original) as SourceMapLike;
  } catch {
    return undefined;
  }

  if (!map || typeof map.mappings !== 'string') {
    return undefined;
  }

  const lineStarts = collectLineStarts(originalCode);
  const lineDeltas = new Map<
    number,
    Array<{ column: number; delta: number }>
  >();

  for (const edit of edits) {
    if (edit.start !== edit.end) {
      return undefined;
    }
    if (edit.text.includes('\n') || edit.text.includes('\r')) {
      return undefined;
    }

    const position = getLineColumnOffset(lineStarts, edit.start);
    const entries = lineDeltas.get(position.line) ?? [];
    entries.push({
      column: position.column,
      delta: edit.text.length,
    });
    lineDeltas.set(position.line, entries);
  }

  if (lineDeltas.size === 0) {
    return undefined;
  }

  const decodedMappings = decode(map.mappings);

  for (const [line, entries] of lineDeltas.entries()) {
    const segments = decodedMappings[line];
    if (!segments || segments.length === 0) {
      continue;
    }

    const sortedEntries = [...entries].sort(
      (lhs, rhs) => lhs.column - rhs.column
    );
    let entryIndex = 0;
    let cumulativeDelta = 0;

    for (const segment of segments) {
      while (
        entryIndex < sortedEntries.length &&
        sortedEntries[entryIndex].column <= segment[0]
      ) {
        cumulativeDelta += sortedEntries[entryIndex].delta;
        entryIndex += 1;
      }

      segment[0] += cumulativeDelta;
    }
  }

  map.mappings = encode(decodedMappings);
  const serialized = JSON.stringify(map);
  return original.endsWith('\n') ? `${serialized}\n` : serialized;
};
