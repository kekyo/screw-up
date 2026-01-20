// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, extname, join } from 'path';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

export type ModuleInteropKind = 'cjs' | 'esm' | 'unresolvable' | 'unknown';

const importConditions = ['import', 'node', 'default'] as const;

const stripQuery = (id: string): string => {
  const queryIndex = id.indexOf('?');
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
};

const isBareSpecifier = (specifier: string): boolean => {
  if (!specifier) {
    return false;
  }
  if (specifier.startsWith('.')) {
    return false;
  }
  if (specifier.startsWith('/') || specifier.startsWith('\\')) {
    return false;
  }
  if (specifier.startsWith('node:')) {
    return false;
  }
  if (specifier.includes(':')) {
    return false;
  }
  return true;
};

const parsePackageName = (
  specifier: string
): { packageName: string; subpath: string } => {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length >= 2) {
      return {
        packageName: `${parts[0]}/${parts[1]}`,
        subpath: parts.slice(2).join('/'),
      };
    }
  }
  const [packageName, ...rest] = specifier.split('/');
  return { packageName, subpath: rest.join('/') };
};

const findPackageJsonPath = (
  packageName: string,
  importerDir: string
): string | undefined => {
  let current = importerDir;
  while (true) {
    const candidate = join(
      current,
      'node_modules',
      packageName,
      'package.json'
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

const readPackageJson = async (
  packageJsonPath: string
): Promise<Record<string, unknown> | undefined> => {
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const resolveExportTarget = (
  target: unknown,
  subpath: string,
  conditions: readonly string[]
): string | undefined => {
  if (typeof target === 'string') {
    if (subpath && subpath !== '.') {
      return undefined;
    }
    return target;
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveExportTarget(entry, subpath, conditions);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }
  if (!target || typeof target !== 'object') {
    return undefined;
  }

  const record = target as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasSubpathMap = keys.some((key) => key.startsWith('.'));

  if (hasSubpathMap) {
    const subpathKey =
      subpath === '' || subpath === '.'
        ? '.'
        : subpath.startsWith('./')
          ? subpath
          : `./${subpath}`;
    if (!(subpathKey in record)) {
      return undefined;
    }
    return resolveExportTarget(record[subpathKey], '.', conditions);
  }

  for (const condition of conditions) {
    if (condition in record) {
      const resolved = resolveExportTarget(
        record[condition],
        subpath,
        conditions
      );
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
};

const inferModuleKindFromPath = (
  targetPath: string,
  packageType: string | undefined
): ModuleInteropKind => {
  const ext = extname(targetPath);
  if (ext === '.mjs') {
    return 'esm';
  }
  if (ext === '.cjs') {
    return 'cjs';
  }
  if (ext === '.js' || ext === '') {
    return packageType === 'module' ? 'esm' : 'cjs';
  }
  return packageType === 'module' ? 'esm' : 'cjs';
};

const resolveModuleKindFromPackage = (
  packageJson: Record<string, unknown>,
  subpath: string
): ModuleInteropKind => {
  const packageType =
    typeof packageJson.type === 'string' ? packageJson.type : undefined;
  if (packageJson.exports !== undefined) {
    const resolved = resolveExportTarget(
      packageJson.exports,
      subpath,
      importConditions
    );
    if (!resolved) {
      return 'unresolvable';
    }
    return inferModuleKindFromPath(resolved, packageType);
  }

  if (subpath) {
    return inferModuleKindFromPath(subpath, packageType);
  }

  const main =
    typeof packageJson.main === 'string' ? packageJson.main : 'index.js';
  return inferModuleKindFromPath(main, packageType);
};

export const createNodeModuleKindResolver = () => {
  const packageJsonCache = new Map<string, Record<string, unknown> | null>();
  const resolveCache = new Map<string, ModuleInteropKind>();

  return async (
    specifier: string,
    importer: string
  ): Promise<ModuleInteropKind> => {
    if (!isBareSpecifier(specifier)) {
      return 'unknown';
    }

    const importerPath = stripQuery(importer);
    const importerDir = dirname(importerPath);
    const { packageName, subpath } = parsePackageName(specifier);
    const packageJsonPath = findPackageJsonPath(packageName, importerDir);
    if (!packageJsonPath) {
      return 'unknown';
    }

    const cacheKey = `${packageJsonPath}:${subpath}`;
    const cached = resolveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let packageJson = packageJsonCache.get(packageJsonPath);
    if (packageJson === undefined) {
      packageJson = (await readPackageJson(packageJsonPath)) ?? null;
      packageJsonCache.set(packageJsonPath, packageJson);
    }
    if (!packageJson) {
      resolveCache.set(cacheKey, 'unknown');
      return 'unknown';
    }

    const resolved = resolveModuleKindFromPackage(packageJson, subpath);
    resolveCache.set(cacheKey, resolved);
    return resolved;
  };
};

export const scanHasDefaultImport = (
  ts: typeof import('typescript'),
  code: string
): boolean => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    true,
    ts.LanguageVariant.Standard,
    code
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.ImportKeyword) {
      const next = scanner.scan();
      if (next === ts.SyntaxKind.OpenParenToken) {
        token = scanner.scan();
        continue;
      }
      if (
        next === ts.SyntaxKind.Identifier ||
        next === ts.SyntaxKind.TypeKeyword
      ) {
        return true;
      }
    }
    token = scanner.scan();
  }
  return false;
};

const helperFunctionSource = `function __resolveDefaultExport<T>(module: T | { default?: T }): T {
  return (module as { default?: T }).default ?? (module as T);
}`;

const hasResolveDefaultExport = (
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile
): boolean => {
  return sourceFile.statements.some((statement) => {
    if (ts.isFunctionDeclaration(statement)) {
      return statement.name?.text === '__resolveDefaultExport';
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) => {
        return (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === '__resolveDefaultExport'
        );
      });
    }
    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause;
      if (!importClause) {
        return false;
      }
      if (importClause.name?.text === '__resolveDefaultExport') {
        return true;
      }
      if (importClause.namedBindings) {
        if (ts.isNamespaceImport(importClause.namedBindings)) {
          return (
            importClause.namedBindings.name.text === '__resolveDefaultExport'
          );
        }
        if (ts.isNamedImports(importClause.namedBindings)) {
          return importClause.namedBindings.elements.some(
            (element) =>
              element.name.text === '__resolveDefaultExport' ||
              element.propertyName?.text === '__resolveDefaultExport'
          );
        }
      }
    }
    return false;
  });
};

const isTypeOnlyImportClause = (
  ts: typeof import('typescript'),
  importClause: import('typescript').ImportClause
): boolean => {
  const phaseModifier = (importClause as { phaseModifier?: number })
    .phaseModifier;
  if (phaseModifier !== undefined) {
    return phaseModifier === ts.SyntaxKind.TypeKeyword;
  }
  return Boolean((importClause as { isTypeOnly?: boolean }).isTypeOnly);
};

const getScriptKind = (
  ts: typeof import('typescript'),
  id: string
): import('typescript').ScriptKind => {
  if (id.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (id.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (id.endsWith('.mts')) {
    const mts = (ts.ScriptKind as unknown as Record<string, number>)['MTS'];
    return mts ?? ts.ScriptKind.TS;
  }
  if (id.endsWith('.cts')) {
    const cts = (ts.ScriptKind as unknown as Record<string, number>)['CTS'];
    return cts ?? ts.ScriptKind.TS;
  }
  if (id.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  if (id.endsWith('.mjs')) {
    return ts.ScriptKind.JS;
  }
  if (id.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.JS;
};

const formatModuleSpecifier = (specifier: string): string => {
  const escaped = specifier.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
};

const buildNamedImport = (
  moduleName: string,
  namedBindings: import('typescript').NamedImports
): string => {
  const elements = namedBindings.elements
    .map((specifier) => {
      const alias = specifier.propertyName
        ? `${specifier.propertyName.text} as ${specifier.name.text}`
        : specifier.name.text;
      return specifier.isTypeOnly ? `type ${alias}` : alias;
    })
    .join(', ');
  return `import { ${elements} } from ${formatModuleSpecifier(moduleName)};`;
};

export const transformDefaultImports = async (
  ts: typeof import('typescript'),
  code: string,
  id: string,
  resolveModuleKind: (
    specifier: string,
    importer: string
  ) => Promise<ModuleInteropKind>
): Promise<{ code: string; changed: boolean }> => {
  const normalizedId = stripQuery(id);
  const sourceFile = ts.createSourceFile(
    normalizedId,
    code,
    ts.ScriptTarget.ESNext,
    false,
    getScriptKind(ts, normalizedId)
  );

  const edits: Array<{ start: number; end: number; text: string }> = [];
  let needsHelper = false;
  const helperPresent = hasResolveDefaultExport(ts, sourceFile);
  let namespaceIndex = 0;

  const usedNamespace = (base: string): string => {
    let candidate = `${base}${namespaceIndex}`;
    while (code.includes(candidate)) {
      namespaceIndex += 1;
      candidate = `${base}${namespaceIndex}`;
    }
    namespaceIndex += 1;
    return candidate;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause || !importClause.name) {
      continue;
    }
    if (isTypeOnlyImportClause(ts, importClause)) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const moduleKind = await resolveModuleKind(moduleName, normalizedId);
    if (moduleKind !== 'cjs') {
      continue;
    }

    const defaultName = importClause.name.text;
    const replacementImports: string[] = [];
    let namespaceName: string;

    if (
      importClause.namedBindings &&
      ts.isNamespaceImport(importClause.namedBindings)
    ) {
      namespaceName = importClause.namedBindings.name.text;
      replacementImports.push(
        `import * as ${namespaceName} from ${formatModuleSpecifier(moduleName)};`
      );
    } else {
      namespaceName = usedNamespace('__screwUpDefaultImportModule');
      replacementImports.push(
        `import * as ${namespaceName} from ${formatModuleSpecifier(moduleName)};`
      );
      if (
        importClause.namedBindings &&
        ts.isNamedImports(importClause.namedBindings)
      ) {
        replacementImports.push(
          buildNamedImport(moduleName, importClause.namedBindings)
        );
      }
    }

    const replacement =
      `${replacementImports.join('\n')}\n` +
      `const ${defaultName} = __resolveDefaultExport(${namespaceName});`;

    edits.push({
      start: statement.getStart(sourceFile),
      end: statement.getEnd(),
      text: replacement,
    });
    needsHelper = true;
  }

  if (edits.length === 0) {
    return { code, changed: false };
  }

  if (needsHelper && !helperPresent) {
    const importStatements = sourceFile.statements.filter(
      ts.isImportDeclaration
    );
    const lastImport = importStatements[importStatements.length - 1];
    if (lastImport) {
      const newline = code.includes('\r\n') ? '\r\n' : '\n';
      edits.push({
        start: lastImport.getEnd(),
        end: lastImport.getEnd(),
        text: `${newline}${helperFunctionSource}${newline}`,
      });
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let nextCode = code;
  for (const edit of edits) {
    nextCode =
      nextCode.slice(0, edit.start) + edit.text + nextCode.slice(edit.end);
  }

  return { code: nextCode, changed: true };
};
