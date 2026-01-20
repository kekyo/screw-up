// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import type {
  NormalizedOutputOptions,
  OutputAsset,
  OutputChunk,
  OutputOptions,
} from 'rollup';
import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createMutex } from 'async-primitives';

import { git_commit_hash, name, version } from './generated/packageMetadata';
import { resolvePackageMetadata, createConsoleLogger } from './internal';
import { ScrewUpOptions, PackageMetadata } from './types';
import { getFetchGitMetadata } from './analyzer';
import {
  createNodeModuleKindResolver,
  scanHasDefaultImport,
  transformDefaultImports,
} from './default-import-fix';
import {
  ensureMetadataGitignore,
  generateMetadataFileContent,
  writeFileIfChanged,
} from './metadata-file';

//////////////////////////////////////////////////////////////////////////////////

/**
 * Generate banner string from package.json metadata
 * @param metadata - Package metadata
 * @param outputKeys - Array of keys to output in specified order
 * @returns Banner string
 */
export const generateBanner = (
  metadata: PackageMetadata,
  outputKeys: readonly string[]
): string => {
  const parts: string[] = [];

  for (const key of outputKeys) {
    const value = metadata[key];
    if (value) {
      parts.push(`${key}: ${value}`);
    }
  }

  return parts.length > 0 ? `/*!\n * ${parts.join('\n * ')}\n */` : '';
};

/**
 * Insert banner header at appropriate position considering shebang
 * @param content - The content to insert banner into
 * @param banner - The banner header to insert
 * @returns Content with banner header inserted
 */
const insertBannerHeader = (content: string, banner: string): string => {
  const lines = content.split('\n');

  // Check if first line is shebang
  if (lines.length > 0 && lines[0].startsWith('#!')) {
    // Insert banner after shebang line
    return lines[0] + '\n' + banner + '\n' + lines.slice(1).join('\n');
  } else {
    // Insert banner at the beginning
    return banner + '\n' + content;
  }
};

/**
 * Split a leading shebang from content, keeping the shebang line with newline.
 */
const splitShebang = (content: string): { shebang: string; rest: string } => {
  if (!content.startsWith('#!')) {
    return { shebang: '', rest: content };
  }
  const newlineIndex = content.indexOf('\n');
  if (newlineIndex === -1) {
    return { shebang: `${content}\n`, rest: '' };
  }
  return {
    shebang: content.slice(0, newlineIndex + 1),
    rest: content.slice(newlineIndex + 1),
  };
};

/**
 * Adds a trailing newline to the banner text when needed so subsequent
 * concatenations do not collapse onto the last line.
 */
const ensureTrailingNewline = (value: string, newline: string): string =>
  value.endsWith(newline) ? value : value + newline;

/**
 * Merge screw-up's metadata banner with an existing Rollup banner, keeping any
 * shebang line at the very top and preventing duplicate metadata blocks.
 */
const mergeBanners = (
  currentBanner: string,
  existingBanner: string
): string => {
  if (!currentBanner) {
    return existingBanner;
  }
  if (!existingBanner) {
    return currentBanner;
  }

  if (existingBanner.includes(currentBanner)) {
    return existingBanner;
  }

  // Preserve shebang at the very top while sliding the metadata banner underneath it.
  const shebangMatch = existingBanner.match(/^(#![^\r\n]*)(\r?\n)?([\s\S]*)$/);
  if (shebangMatch) {
    const [, shebangLine, newlineSeq = '\n', rest = ''] = shebangMatch;
    if (rest.startsWith(currentBanner)) {
      return existingBanner;
    }
    const currentWithNewline = ensureTrailingNewline(currentBanner, newlineSeq);
    if (rest.length === 0) {
      return `${shebangLine}${newlineSeq}${currentWithNewline}`;
    }
    return `${shebangLine}${newlineSeq}${currentWithNewline}${rest}`;
  }

  // Default path: prepend metadata banner before the previous banner content.
  const newlineSeq = existingBanner.includes('\r\n') ? '\r\n' : '\n';
  const currentWithNewline = ensureTrailingNewline(currentBanner, newlineSeq);
  return `${currentWithNewline}${existingBanner}`;
};

/**
 * Count how many newline characters exist in the banner block.
 * The result equals the line delta that needs to be applied to sourcemaps.
 */
const countInsertedLines = (bannerWithTrailingNewline: string): number => {
  return bannerWithTrailingNewline.split('\n').length - 1;
};

/**
 * Convert asset payloads to UTF-8 strings to simplify sourcemap adjustments.
 */
const stringifyAssetSource = (source: string | Uint8Array): string =>
  typeof source === 'string' ? source : Buffer.from(source).toString('utf-8');

/**
 * Prepend the specified number of empty lines to a sourcemap by adding semicolons
 * at the beginning of the VLQ mappings string.
 * @returns Updated sourcemap JSON string, or undefined if no change is needed.
 */
const applyLineOffsetToSourceMap = (
  source: string | Uint8Array,
  lineOffset: number
): string | undefined => {
  if (lineOffset <= 0) {
    return undefined;
  }

  const original = stringifyAssetSource(source);
  let map: any;
  try {
    map = JSON.parse(original);
  } catch {
    return undefined;
  }

  if (!map || typeof map.mappings !== 'string') {
    return undefined;
  }

  const prefix = ';'.repeat(lineOffset);
  if (map.mappings.startsWith(prefix)) {
    return undefined;
  }

  map.mappings = prefix + map.mappings;
  const serialized = JSON.stringify(map);
  return original.endsWith('\n') ? `${serialized}\n` : serialized;
};

/**
 * Prepend empty lines to sourcemap objects for chunk outputs.
 */
const applyLineOffsetToSourceMapObject = (
  map: any,
  lineOffset: number
): void => {
  if (!map || lineOffset <= 0 || typeof map.mappings !== 'string') {
    return;
  }
  const prefix = ';'.repeat(lineOffset);
  if (map.mappings.startsWith(prefix)) {
    return;
  }
  map.mappings = prefix + map.mappings;
};

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Vite plugin that adds banner to the bundled code
 * @param options - Plugin options
 * @returns Vite plugin
 */
export const screwUp = (options: ScrewUpOptions = {}): Plugin => {
  const {
    fixDefaultImport = true,
    outputKeys = [
      'name',
      'version',
      'description',
      'author',
      'license',
      'repository.url',
      'git.commit.hash',
    ],
    assetFilters = ['\\.d\\.ts$'],
    outputMetadataFile = false,
    outputMetadataFilePath = 'src/generated/packageMetadata.ts',
    outputMetadataKeys = [
      'name',
      'version',
      'description',
      'author',
      'license',
      'repository.url',
      'git.commit.hash',
    ],
    checkWorkingDirectoryStatus = true,
    alwaysOverrideVersionFromGit = true,
    insertMetadataBanner = true,
  } = options;

  const assetFiltersRegex = assetFilters.map((filter) => new RegExp(filter));
  const generateMetadataSourceLocker = createMutex();
  const resolveModuleKind = createNodeModuleKindResolver();
  let typescriptPromise:
    | Promise<typeof import('typescript') | undefined>
    | undefined;

  const loggerPrefix = `${name}-vite`;
  let logger = createConsoleLogger(loggerPrefix);
  let banner = '';
  let metadata: any;
  let projectRoot: string;
  let fetchGitMetadata = () => Promise.resolve<any>({});

  const loadTypeScript = async () => {
    if (!typescriptPromise) {
      typescriptPromise = import('typescript').catch(() => undefined);
    }
    return typescriptPromise;
  };

  const resolveOutputBanner = async (
    outputOptions: NormalizedOutputOptions,
    chunk: OutputChunk
  ): Promise<string> => {
    const outputBanner = outputOptions.banner;
    if (typeof outputBanner === 'function') {
      const resolved = await outputBanner(chunk);
      return resolved ?? banner ?? '';
    }
    return outputBanner ?? banner ?? '';
  };

  // Generate and write metadata TypeScript file
  const generateMetadataSourceFiles = async () => {
    // Resolve package metadata
    const result = await resolvePackageMetadata(
      projectRoot,
      fetchGitMetadata,
      alwaysOverrideVersionFromGit,
      logger
    );
    metadata = result.metadata;
    // Regenerate banner with updated metadata
    banner = generateBanner(metadata, outputKeys);
    if (outputMetadataFile) {
      const metadataSourceContent = generateMetadataFileContent(
        metadata,
        outputMetadataKeys
      );
      const metadataSourcePath = join(projectRoot, outputMetadataFilePath);
      const metadataWritten = await writeFileIfChanged(
        metadataSourcePath,
        metadataSourceContent,
        'metadata source file',
        logger
      );
      if (existsSync(metadataSourcePath)) {
        const gitignoreWritten = await ensureMetadataGitignore(
          metadataSourcePath,
          logger
        );
        if (gitignoreWritten) {
          logger.info(
            `generateMetadataSourceFile: .gitignore is generated: ${join(
              dirname(outputMetadataFilePath),
              '.gitignore'
            )}`
          );
        }
      }
      return metadataWritten;
    }
    return false;
  };

  // Generate dummy metadata TypeScript file with empty string values
  const generateMetadataFileFromKeys = async (keys: readonly string[]) => {
    if (outputMetadataFile) {
      const metadataSourcePath = join(projectRoot, outputMetadataFilePath);
      // Only generate if file doesn't exist (don't overwrite existing files)
      if (!existsSync(metadataSourcePath)) {
        // Create dummy metadata with empty strings for all keys
        const dummyMetadata: any = {};
        keys.forEach((key) => {
          dummyMetadata[key] = '[Require first build]';
        });
        const dummyContent = generateMetadataFileContent(dummyMetadata, keys);
        return await writeFileIfChanged(
          metadataSourcePath,
          dummyContent,
          'dummy metadata source file',
          logger
        );
      }
    }
    return false;
  };

  return {
    name: 'screw-up',
    // Ensure screw-up runs before other plugins
    // (especially vite-plugin-dts, avoid packageMetadata.ts is not found)
    enforce: 'pre',
    // Plugin starting
    applyToEnvironment: async (penv) => {
      // Prime metadata generation once so dependent files are ready immediately
      logger.info(`${version}-${git_commit_hash}: Started.`);

      // Partial (but maybe exact) project root
      projectRoot = penv.config.root;

      // Generate dummy metadata source file to prevent import errors on initial build
      if (
        projectRoot &&
        (await generateMetadataFileFromKeys(outputMetadataKeys))
      ) {
        logger.info(
          `applyToEnvironment: Dummy metadata source file is generated: ${outputMetadataFilePath}`
        );
      }

      return true;
    },
    // Build configuration phase
    config: (config) => {
      // When banner injection is disabled, leave rollup output untouched
      if (!insertMetadataBanner) {
        return;
      }

      config.build ??= {};
      const rollupOptions = (config.build.rollupOptions ??= {});
      // Normalize rollup outputs to an array so we can inject a banner even when empty
      const ensureOutputs = (): OutputOptions[] => {
        // Consumer already supplied an array of outputs (possibly empty)
        if (Array.isArray(rollupOptions.output)) {
          const outputs = rollupOptions.output as OutputOptions[];
          // Array exists but contains no entry yet; create one lazily
          if (outputs.length === 0) {
            const output: OutputOptions = {};
            outputs.push(output);
            return outputs;
          }
          outputs.forEach((output, index) => {
            // Array slot is nullish (user emptied it); replace with object to keep consistent
            if (!output) {
              outputs[index] = {};
            }
          });
          return outputs;
        }

        // Single output object was provided; wrap it to unify processing
        if (rollupOptions.output) {
          return [rollupOptions.output as OutputOptions];
        }

        // No output specified at all; create placeholder so banner hook can run
        const output: OutputOptions = {};
        rollupOptions.output = output;
        return [output];
      };

      const outputs = ensureOutputs();

      outputs.forEach((output) => {
        const previousBanner = output.banner;
        // Preserve any existing banner configuration and append ours later in order
        const resolvePreviousBanner = async (chunk: any) => {
          // User provided banner as function; resolve it per chunk for compatibility
          if (typeof previousBanner === 'function') {
            const resolved = await previousBanner(chunk);
            return resolved ?? '';
          }
          return previousBanner ?? '';
        };

        output.banner = async (chunk: any) => {
          const existingBanner = await resolvePreviousBanner(chunk);
          const currentBanner = banner ?? '';
          return mergeBanners(currentBanner, existingBanner);
        };
      });
    },
    transform: async (code, id) => {
      if (!fixDefaultImport || !id || id.includes('\0')) {
        return;
      }
      const cleanId = id.split('?')[0];
      if (cleanId.includes('node_modules')) {
        return;
      }
      if (
        cleanId.endsWith('.d.ts') ||
        cleanId.endsWith('.d.mts') ||
        cleanId.endsWith('.d.cts')
      ) {
        return;
      }
      if (!/\.(?:[cm]?[jt]sx?|[cm]js)$/.test(cleanId)) {
        return;
      }

      const ts = await loadTypeScript();
      if (!ts) {
        return;
      }
      const hasDefaultImport = scanHasDefaultImport(ts, code);
      if (cleanId.includes('/src/') || cleanId.includes('\\src\\')) {
        logger.debug(
          `[fixDefaultImport] scan ${cleanId}: ${
            hasDefaultImport ? 'hit' : 'miss'
          }`
        );
      }
      if (!hasDefaultImport) {
        return;
      }

      const result = await transformDefaultImports(
        ts,
        code,
        cleanId,
        resolveModuleKind
      );
      if (result.changed) {
        return {
          code: result.code,
          map: null,
        };
      }
    },
    // Configuration resolved phase
    configResolved: async (config) => {
      // Avoid race conditions.
      const l = await generateMetadataSourceLocker.lock();
      try {
        // Enable debug logging for performance analysis
        const tempEnableLogging = true;

        // Save project root
        projectRoot = config.root;
        if (tempEnableLogging || config?.logger) {
          logger = createConsoleLogger(loggerPrefix, config.logger);
        } else if (config?.customLogger) {
          logger = createConsoleLogger(loggerPrefix, config.customLogger);
        }

        logger.debug(`configResolved: Started.`);
        // Get Git metadata fetcher function
        fetchGitMetadata = getFetchGitMetadata(
          projectRoot,
          checkWorkingDirectoryStatus,
          logger
        );
        // Refresh banner string and generated files before TypeScript compilation kicks in
        // Generate metadata TypeScript file early to ensure it's available during TypeScript compilation
        if (await generateMetadataSourceFiles()) {
          logger.info(
            `configResolved: Metadata source file is generated: ${outputMetadataFilePath}`
          );
        }
      } finally {
        logger.debug(`configResolved: Exited.`);
        l.release();
      }
    },
    // Server hook
    configureServer: async (server) => {
      // Avoid race conditions.
      const l = await generateMetadataSourceLocker.lock();
      try {
        logger.debug(`configureServer: Started.`);

        // Exclude generated metadata file from watcher to prevent infinite loop
        // Metadata file output is enabled and watcher is present; unwatch to avoid churn
        if (outputMetadataFile && server.watcher) {
          const metadataSourcePath = join(projectRoot, outputMetadataFilePath);
          // Use unwatch to exclude the file from being watched
          server.watcher.unwatch(metadataSourcePath);
          logger.debug(
            `configureServer: Excluded from watcher: ${outputMetadataFilePath}`
          );
        }

        // Rebuild banner metadata on dev server startup to keep values fresh
        if (await generateMetadataSourceFiles()) {
          logger.info(
            `configureServer: Metadata source file is generated: ${outputMetadataFilePath}`
          );
        }
      } finally {
        logger.debug(`configureServer: Exited.`);
        l.release();
      }
    },
    // Build start phase
    buildStart: async () => {
      // Avoid race conditions.
      const l = await generateMetadataSourceLocker.lock();
      try {
        logger.debug(`buildStart: Started.`);
        // Re-resolve package metadata to capture any changes since configResolved
        // Update metadata TypeScript file with latest data
        if (await generateMetadataSourceFiles()) {
          logger.info(
            `buildStart: Metadata source file is generated: ${outputMetadataFilePath}`
          );
        }
      } finally {
        logger.debug(`buildStart: Exited.`);
        l.release();
      }
    },
    // Generate bundle phase
    generateBundle: {
      order: 'post',
      handler: async (outputOptions, bundle) => {
        // Add banner to each output file if enabled
        if (insertMetadataBanner) {
          let chunkCount = 0;
          for (const fileName in bundle) {
            const output = bundle[fileName];
            if (output.type === 'chunk') {
              const chunk = output as OutputChunk;
              const resolvedBanner = await resolveOutputBanner(
                outputOptions,
                chunk
              );
              if (!resolvedBanner) {
                continue;
              }
              const { shebang: bannerShebang, rest: bannerRest } =
                splitShebang(resolvedBanner);
              const bannerCore = bannerRest.trimEnd();
              if (!bannerCore || chunk.code.includes(bannerCore)) {
                continue;
              }
              const originalCode = chunk.code;
              let nextCode = originalCode;
              if (bannerShebang && !nextCode.startsWith('#!')) {
                nextCode = `${bannerShebang}${nextCode}`;
              }
              const bannerBlock = ensureTrailingNewline(bannerCore, '\n');
              nextCode = insertBannerHeader(nextCode, bannerBlock);
              if (nextCode === originalCode) {
                continue;
              }
              const lineOffset =
                nextCode.split('\n').length - originalCode.split('\n').length;
              chunk.code = nextCode;
              if (lineOffset > 0 && chunk.map) {
                applyLineOffsetToSourceMapObject(chunk.map, lineOffset);
              }
              const mapFileName = `${fileName}.map`;
              const mapAsset = bundle[mapFileName] as OutputAsset | undefined;
              if (
                lineOffset > 0 &&
                mapAsset &&
                mapAsset.type === 'asset' &&
                mapAsset.source !== undefined
              ) {
                const adjusted = applyLineOffsetToSourceMap(
                  mapAsset.source,
                  lineOffset
                );
                if (adjusted !== undefined) {
                  mapAsset.source = adjusted;
                }
              }
              chunkCount++;
            }
          }
          if (chunkCount >= 1) {
            logger.debug(
              `generateBundle: Banner header reinserted: ${chunkCount} file(s)`
            );
          }

          let assetCount = 0;
          for (const fileName in bundle) {
            const chunk = bundle[fileName];
            if (
              // Only treat assets that match filters; JS chunks already handled via rollup banner
              chunk.type === 'asset' &&
              assetFiltersRegex.some((filter) => filter.test(fileName))
            ) {
              if (typeof chunk.source === 'string') {
                // Assets are not covered by rollup banner injection, so prepend manually
                const bannerBlock = `${banner}\n`;
                // Insert banner while preserving shebang semantics and capture line delta for maps
                chunk.source = insertBannerHeader(chunk.source, bannerBlock); // insert more blank line
                const lineOffset = countInsertedLines(bannerBlock);

                const mapFileName = `${fileName}.map`;
                const mapAsset = bundle[mapFileName] as OutputAsset | undefined;
                if (
                  mapAsset &&
                  mapAsset.type === 'asset' &&
                  mapAsset.source !== undefined
                ) {
                  // Rewrite the sourcemap mappings so declaration lines still map back correctly
                  const adjusted = applyLineOffsetToSourceMap(
                    mapAsset.source,
                    lineOffset
                  );
                  if (adjusted !== undefined) {
                    mapAsset.source = adjusted;
                  }
                }
                assetCount++;
              }
            }
          }
          if (assetCount >= 1) {
            logger.debug(
              `generateBundle: Banner header inserted: ${assetCount} file(s)`
            );
          }
        }
      },
    },
    // Write bundle phase
    writeBundle: async (options) => {
      // Handle files written by other plugins (like vite-plugin-dts) if banner insertion is enabled
      if (!insertMetadataBanner || !options.dir) return;

      try {
        // Read all files in the output directory
        const files = await readdir(options.dir, { recursive: true });

        // Iterate over all files
        let count = 0;
        for (const file of files) {
          const filePath = join(options.dir, file);

          // Check if the file is target asset file
          // Apply banner only to filtered assets in post-write stage
          if (assetFiltersRegex.some((filter) => filter.test(file))) {
            try {
              // Read the asset file
              const content = await readFile(filePath, 'utf-8');
              // Append banner to the asset file if it doesn't already contain it
              if (!content.includes(banner)) {
                // Backfill banners onto assets emitted by other plugins as well
                const bannerBlock = `${banner}\n`;
                await writeFile(
                  filePath,
                  insertBannerHeader(content, bannerBlock)
                );

                const lineOffset = countInsertedLines(bannerBlock);
                const mapPath = `${filePath}.map`;
                try {
                  const mapContent = await readFile(mapPath, 'utf-8');
                  // Align existing .d.ts.map files so consumer toolchains see accurate positions
                  const adjusted = applyLineOffsetToSourceMap(
                    mapContent,
                    lineOffset
                  );
                  if (adjusted !== undefined) {
                    await writeFile(mapPath, adjusted);
                  }
                } catch {
                  // Declarations without sourcemap can be safely ignored
                }
                count++;
              }
            } catch (error) {
              // Skip files that can't be read/written
            }
          }
        }
        if (count >= 1) {
          logger.debug(`writeBundle: Banner header inserted: ${count} file(s)`);
        }
      } catch (error) {
        // Skip files that can't be read/written
      }
    },
  };
};
