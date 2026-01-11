// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import {
  packAssets,
  parseArgs,
  ParsedArgs,
  getComputedPackageJsonObject,
  resolveWorkspaceFilesMerge,
} from './cli-internal';
import { getFetchGitMetadata } from './analyzer';
import { Logger, resolvePackageMetadata } from './internal';
import {
  ensureMetadataGitignore,
  generateMetadataFileContent,
  writeFileIfChanged,
} from './metadata-file';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

// Package metadata fields that should be inherited from parent
const defaultInheritableFields = new Set([
  'version',
  'description',
  'author',
  'license',
  'repository',
  'keywords',
  'homepage',
  'bugs',
  'readme',
  'files',
]);

const defaultOutputMetadataKeys = [
  'name',
  'version',
  'description',
  'author',
  'license',
  'repository.url',
  'git.commit.hash',
];

// Parse inheritable fields from CLI option string
const parseInheritableFields = (
  inheritableFieldsOption: string | boolean | undefined
): Set<string> => {
  if (typeof inheritableFieldsOption !== 'string') {
    return defaultInheritableFields;
  }
  if (!inheritableFieldsOption.trim()) {
    return new Set(); // Empty set for empty string (no inheritance)
  }
  return new Set(
    inheritableFieldsOption
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0)
  );
};

const parseOutputMetadataKeys = (
  outputMetadataKeysOption: string | boolean | undefined
): readonly string[] => {
  if (typeof outputMetadataKeysOption !== 'string') {
    return defaultOutputMetadataKeys;
  }
  if (!outputMetadataKeysOption.trim()) {
    return [];
  }
  return outputMetadataKeysOption
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
};

//////////////////////////////////////////////////////////////////////////////////

const readInputText = async (inputPath?: string): Promise<string> => {
  if (inputPath) {
    const resolvedPath = resolve(inputPath);
    return await readFile(resolvedPath, 'utf-8');
  }

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', (err) => rejectPromise(err));
  });
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getValueByPath = (source: any, path: string): any => {
  return path.split('.').reduce<any>((current, key) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (typeof current !== 'object' && !Array.isArray(current)) {
      return undefined;
    }
    return (current as any)[key];
  }, source);
};

const stringifyValue = (value: any): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const replacePlaceholders = (
  text: string,
  values: any,
  openBracket: string,
  closeBracket: string
): string => {
  const pattern = new RegExp(
    `${escapeRegExp(openBracket)}(.*?)${escapeRegExp(closeBracket)}`,
    'g'
  );
  return text.replace(pattern, (match, key) => {
    const trimmedKey = String(key).trim();
    const resolvedValue = stringifyValue(getValueByPath(values, trimmedKey));
    return resolvedValue !== undefined ? resolvedValue : match;
  });
};

//////////////////////////////////////////////////////////////////////////////////

const showFormatHelp = () => {
  console.info(`Usage: screw-up format [options] [output]

Format input text by replacing placeholders with package metadata

Arguments:
  output                        Optional output file path (default: stdout)

Options:
  -i, --input <path>            Input template file (default: stdin)
  -b, --bracket <open,close>    Placeholder brackets (default: {,})
  --inheritable-fields <list>   Comma-separated list of fields to inherit from parent
  --no-wds                      Do not check working directory status to increase version
  --no-git-version-override     Do not override version from Git (use package.json version)
  -f, --force                   Allow formatting even if package.json does not exist
  -h, --help                    Show help for format command
`);
};

const parseBracketOption = (
  bracketOption: string | undefined
): { openBracket: string; closeBracket: string } | undefined => {
  if (!bracketOption) {
    return { openBracket: '{', closeBracket: '}' };
  }

  const delimiterIndex = bracketOption.indexOf(',');
  if (delimiterIndex === -1) {
    return undefined;
  }

  const openBracket = bracketOption.slice(0, delimiterIndex);
  const closeBracket = bracketOption.slice(delimiterIndex + 1);

  if (!openBracket || !closeBracket) {
    return undefined;
  }

  return { openBracket, closeBracket };
};

const formatCommand = async (args: ParsedArgs, logger: Logger) => {
  if (args.options.help || args.options.h) {
    showFormatHelp();
    return 1;
  }

  const outputPath = args.positional[0];
  const inputPathOption =
    (args.options['input'] as string) ?? (args.options['i'] as string);
  const bracketOption =
    (args.options['bracket'] as string) ?? (args.options['b'] as string);
  const inheritableFieldsOption = args.options['inheritable-fields'] as string;
  const alwaysOverrideVersionFromGit = !args.options['no-git-version-override'];
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;
  const ignorePackageJsonNotExist =
    args.options['force'] || args.options['f'] ? true : false;

  const bracket = parseBracketOption(
    typeof bracketOption === 'string' ? bracketOption : undefined
  );
  if (!bracket) {
    logger.error(
      'format: Invalid bracket option, expected "open,close" pattern.'
    );
    return 1;
  }

  const { openBracket, closeBracket } = bracket;

  const targetDir = resolve(process.cwd());

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);

  // The format command needs clean output, so ignore debug/info/warn outputs.
  const _logger: Logger = {
    debug: (msg) => {},
    info: (msg) => {},
    warn: (msg) => {},
    error: logger.error,
  };

  try {
    // Get Git metadata fetcher function
    const fetchGitMetadata = getFetchGitMetadata(
      targetDir,
      checkWorkingDirectoryStatus,
      _logger
    );

    // Resolve package metadata
    const computedPackageJson = await getComputedPackageJsonObject(
      targetDir,
      fetchGitMetadata,
      alwaysOverrideVersionFromGit,
      inheritableFields,
      _logger,
      ignorePackageJsonNotExist
    );

    if (!computedPackageJson) {
      _logger.error(`format: Unable to read package.json from: ${targetDir}`);
      return 1;
    }

    const inputText = await readInputText(
      typeof inputPathOption === 'string' ? inputPathOption : undefined
    );

    const formattedText = replacePlaceholders(
      inputText,
      computedPackageJson,
      openBracket,
      closeBracket
    );

    if (outputPath) {
      const resolvedOutputPath = resolve(outputPath);
      await writeFile(resolvedOutputPath, formattedText);
    }

    process.stdout.write(formattedText);
  } catch (error) {
    _logger.error(`format: Failed to format text: ${error}`);
    return 1;
  }

  return 0;
};

//////////////////////////////////////////////////////////////////////////////////

const showDumpHelp = () => {
  console.info(`Usage: screw-up dump [options] [directory]

Dump computed package.json as JSON

Arguments:
  directory                     Directory to dump package.json from (default: current directory)

Options:
  --inheritable-fields <list>   Comma-separated list of fields to inherit from parent
  --no-wds                      Do not check working directory status to increase version
  --no-git-version-override     Do not override version from Git (use package.json version)
  --no-merge-files              Do not merge files from parent package.json
  -f, --force                   Allow dumping even if package.json does not exist
  -h, --help                    Show help for dump command
`);
};

const dumpCommand = async (args: ParsedArgs, logger: Logger) => {
  if (args.options.help || args.options.h) {
    showDumpHelp();
    return 1;
  }

  const directory = args.positional[0];
  const inheritableFieldsOption = args.options['inheritable-fields'] as string;
  const alwaysOverrideVersionFromGit = !args.options['no-git-version-override'];
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;
  const mergeFiles = !args.options['no-merge-files'];
  const ignorePackageJsonNotExist =
    args.options['force'] || args.options['f'] ? true : false;

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);

  const targetDir = resolve(directory ?? process.cwd());

  // The dump command needs clean output, so ignore debug/info/warn outputs.
  const _logger: Logger = {
    debug: (msg) => {},
    info: (msg) => {},
    warn: (msg) => {},
    error: logger.error,
  };

  try {
    // Get Git metadata fetcher function
    const fetchGitMetadata = getFetchGitMetadata(
      targetDir,
      checkWorkingDirectoryStatus,
      _logger
    );

    // Resolve package metadata
    const computedPackageJson = await getComputedPackageJsonObject(
      targetDir,
      fetchGitMetadata,
      alwaysOverrideVersionFromGit,
      inheritableFields,
      _logger,
      ignorePackageJsonNotExist
    );

    if (computedPackageJson) {
      if (
        mergeFiles &&
        inheritableFields.has('files') &&
        existsSync(join(targetDir, 'package.json'))
      ) {
        const workspaceFilesMerge = await resolveWorkspaceFilesMerge(
          targetDir,
          _logger
        );
        if (workspaceFilesMerge?.mergedFiles) {
          computedPackageJson.files = workspaceFilesMerge.mergedFiles;
        }
      }
      // Output console directly
      console.info(JSON.stringify(computedPackageJson, null, 2));
    } else {
      _logger.error(`dump: Unable to read package.json from: ${targetDir}`);
      return 1;
    }
  } catch (error) {
    _logger.error(`dump: Failed to dump package.json: ${error}`);
    return 1;
  }
  return 0;
};

//////////////////////////////////////////////////////////////////////////////////

const showMetadataHelp = () => {
  console.info(`Usage: screw-up metadata [options] [directory]

Generate TypeScript metadata file from package metadata

Arguments:
  directory                          Directory to resolve metadata from (default: current directory)

Options:
  --output-metadata-file-path <path> Output path for metadata file (default: src/generated/packageMetadata.ts)
  --output-metadata-keys <list>      Comma-separated list of metadata keys to include
  --no-wds                           Do not check working directory status to increase version
  --no-git-version-override          Do not override version from Git (use package.json version)
  -h, --help                         Show help for metadata command
`);
};

const metadataCommand = async (args: ParsedArgs, logger: Logger) => {
  if (args.options.help || args.options.h) {
    showMetadataHelp();
    return 1;
  }

  const directory = args.positional[0];
  const outputMetadataFilePathOption =
    args.options['output-metadata-file-path'];
  const outputMetadataKeysOption = args.options['output-metadata-keys'];
  const alwaysOverrideVersionFromGit = !args.options['no-git-version-override'];
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;

  const outputMetadataFilePath =
    typeof outputMetadataFilePathOption === 'string' &&
    outputMetadataFilePathOption.trim()
      ? outputMetadataFilePathOption
      : 'src/generated/packageMetadata.ts';
  const outputMetadataKeys = parseOutputMetadataKeys(outputMetadataKeysOption);

  const targetDir = resolve(directory ?? process.cwd());

  try {
    const fetchGitMetadata = getFetchGitMetadata(
      targetDir,
      checkWorkingDirectoryStatus,
      logger
    );

    const result = await resolvePackageMetadata(
      targetDir,
      fetchGitMetadata,
      alwaysOverrideVersionFromGit,
      logger
    );

    const metadataSourceContent = generateMetadataFileContent(
      result.metadata,
      outputMetadataKeys
    );
    const metadataSourcePath = join(targetDir, outputMetadataFilePath);
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
          `metadata: .gitignore is generated: ${join(
            dirname(outputMetadataFilePath),
            '.gitignore'
          )}`
        );
      }
    }

    if (metadataWritten) {
      logger.info(
        `metadata: Metadata source file is generated: ${outputMetadataFilePath}`
      );
    } else if (existsSync(metadataSourcePath)) {
      logger.info(
        `metadata: Metadata source file is unchanged: ${outputMetadataFilePath}`
      );
    } else {
      logger.error(
        `metadata: Failed to write metadata file: ${outputMetadataFilePath}`
      );
      return 1;
    }
  } catch (error) {
    logger.error(`metadata: Failed to generate metadata file: ${error}`);
    return 1;
  }

  return 0;
};

//////////////////////////////////////////////////////////////////////////////////

const showPackHelp = () => {
  console.info(`Usage: screw-up pack [options] [directory]

Pack the project into a tar archive

Arguments:
  directory                     Directory to pack (default: current directory)

Options:
  --pack-destination <path>     Directory to write the tarball
  --readme <path>               Replace README.md with specified file
  --inheritable-fields <list>   Comma-separated list of fields to inherit from parent
  --no-wds                      Do not check working directory status to increase version
  --no-git-version-override     Do not override version from Git (use package.json version)
  --no-merge-files              Do not merge files from parent package.json
  --no-replace-peer-deps        Disable replacing "*" in peerDependencies with actual versions
  --peer-deps-prefix <prefix>   Version prefix for replaced peerDependencies (default: "^")
  --verbose                     Print verbose log
  -h, --help                    Show help for pack command
`);
};

const packCommand = async (args: ParsedArgs, logger: Logger) => {
  if (args.options.help || args.options.h) {
    showPackHelp();
    return 1;
  }

  const directory = args.positional[0];
  const packDestination = args.options['pack-destination'] as string;
  const readmeOption = args.options['readme'] as string;
  const inheritableFieldsOption = args.options['inheritable-fields'] as string;
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;
  const alwaysOverrideVersionFromGit = !args.options['no-git-version-override'];
  const mergeFiles = !args.options['no-merge-files'];
  const replacePeerDepsWildcards = !args.options['no-replace-peer-deps'];
  const peerDepsVersionPrefix =
    (args.options['peer-deps-prefix'] as string) ?? '^';
  const verbose = args.options['verbose'] ? true : false;

  const targetDir = resolve(directory ?? process.cwd());
  const outputDir = packDestination ? resolve(packDestination) : process.cwd();
  const readmeReplacementPath = readmeOption
    ? resolve(readmeOption)
    : undefined;

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);

  if (verbose) {
    logger.info(`pack: Creating archive of ${targetDir}...`);
  }

  try {
    const result = await packAssets(
      targetDir,
      outputDir,
      checkWorkingDirectoryStatus,
      alwaysOverrideVersionFromGit,
      inheritableFields,
      readmeReplacementPath,
      replacePeerDepsWildcards,
      peerDepsVersionPrefix,
      logger,
      mergeFiles
    );
    if (result) {
      if (verbose) {
        logger.info(
          `pack: Archive created successfully: ${result.packageFileName}`
        );
      } else {
        logger.info(result.packageFileName);
      }
    } else {
      logger.error(`pack: Unable to find any files to pack: ${targetDir}`);
      return 1;
    }
  } catch (error) {
    logger.error(`pack: Failed to create archive: ${error}`);
    return 1;
  }
  return 0;
};

//////////////////////////////////////////////////////////////////////////////////

const showPublishHelp = () => {
  console.info(`Usage: screw-up publish [options] [directory|package.tgz]

Publish the project

Arguments:
  directory|package.tgz         Directory to pack and publish, or existing tarball to publish

Options:
  All npm publish options are supported, including:
  --dry-run                     Perform a dry run
  --tag <tag>                   Tag for the published version
  --access <access>             Access level (public or restricted)
  --registry <registry>         Registry URL
  -h, --help                    Show help for publish command

Examples:
  screw-up publish                       # Publish current directory
  screw-up publish ./my-project          # Publish specific directory
  screw-up publish package.tgz           # Publish existing tarball
  screw-up publish --dry-run --tag beta  # Publish with options
`);
};

const runNpmPublish = async (
  tarballPath: string,
  npmOptions: string[],
  verbose: boolean,
  logger: Logger
) => {
  if (verbose) {
    logger.info(`publish: Publishing ${tarballPath} to npm...`);
  }

  const publishArgs = ['publish', tarballPath, ...npmOptions];

  // For testing: log the command that would be executed
  if (process.env.SCREW_UP_TEST_MODE === 'true') {
    logger.info(`TEST_MODE: Would execute: npm ${publishArgs.join(' ')}`);
    logger.info(`TEST_MODE: Tarball path: ${tarballPath}`);
    logger.info(`TEST_MODE: Options: ${npmOptions.join(' ')}`);
    logger.info(`publish: Successfully published ${tarballPath}`);
    return 0;
  }

  const npmProcess = spawn('npm', publishArgs, { stdio: 'inherit' });

  return new Promise<number>((resolve, reject) => {
    npmProcess.on('close', (code) => {
      if (code === 0) {
        if (verbose) {
          logger.info(`publish: Successfully published ${tarballPath}`);
        }
        resolve(code);
      } else {
        logger.error(`publish: npm publish failed: ${tarballPath}`);
        resolve(code);
      }
    });
    npmProcess.on('error', reject);
  });
};

const publishCommand = async (args: ParsedArgs, logger: Logger) => {
  if (args.options.help || args.options.h) {
    showPublishHelp();
    return 1;
  }

  const path = args.positional[0];
  const readmeOption = args.options['readme'] as string;
  const inheritableFieldsOption = args.options['inheritable-fields'] as string;
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;
  const alwaysOverrideVersionFromGit = !args.options['no-git-version-override'];
  const mergeFiles = !args.options['no-merge-files'];
  const replacePeerDepsWildcards = !args.options['no-replace-peer-deps'];
  const peerDepsVersionPrefix =
    (args.options['peer-deps-prefix'] as string) ?? '^';
  const verbose = args.options['verbose'] ? true : false;

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);
  const readmeReplacementPath = readmeOption
    ? resolve(readmeOption)
    : undefined;

  // Aggregate npm options, except screw-up options.
  const npmOptions: string[] = [];
  for (let i = 0; i < args.argv.length; i++) {
    const arg = args.argv[i];
    if (arg === 'publish') {
      // Skip the command itself
    } else if (
      arg === '--help' ||
      arg === '--verbose' ||
      arg === '-h' ||
      arg === '--no-wds' ||
      arg === '--no-git-version-override' ||
      arg === '--no-merge-files' ||
      arg === '--no-replace-peer-deps'
    ) {
    } else if (
      arg === '--readme' ||
      arg === '--inheritable-fields' ||
      arg === '--peer-deps-prefix'
    ) {
      i++;
    } else {
      npmOptions.push(arg);
    }
  }

  try {
    if (!path) {
      // No argument provided - generate tarball from current directory and publish
      const targetDir = process.cwd();
      const outputDir = await mkdtemp(join(tmpdir(), 'screw-up-publish-'));

      if (verbose) {
        logger.info(`publish: Creating archive of ${targetDir}...`);
      }

      try {
        const result = await packAssets(
          targetDir,
          outputDir,
          checkWorkingDirectoryStatus,
          alwaysOverrideVersionFromGit,
          inheritableFields,
          readmeReplacementPath,
          replacePeerDepsWildcards,
          peerDepsVersionPrefix,
          logger,
          mergeFiles
        );
        if (result?.metadata) {
          if (verbose) {
            logger.info(
              `publish: Archive created successfully: ${result.packageFileName}`
            );
          }
          const archivePath = join(outputDir, result.packageFileName);
          return await runNpmPublish(archivePath, npmOptions, verbose, logger);
        } else {
          logger.error(
            `publish: Unable to find any files to pack: ${targetDir}`
          );
          return 1;
        }
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    } else if (existsSync(path)) {
      const pathStat = await stat(path);

      if (
        pathStat.isFile() &&
        (path.endsWith('.tgz') || path.endsWith('.tar.gz'))
      ) {
        // Argument is a tarball file - publish directly
        return await runNpmPublish(resolve(path), npmOptions, verbose, logger);
      } else if (pathStat.isDirectory()) {
        // Argument is a directory - generate tarball from directory and publish
        const targetDir = resolve(path);
        const outputDir = await mkdtemp(join(tmpdir(), 'screw-up-publish-'));

        if (verbose) {
          logger.info(`publish: Creating archive of ${targetDir}...`);
        }

        try {
          const result = await packAssets(
            targetDir,
            outputDir,
            checkWorkingDirectoryStatus,
            alwaysOverrideVersionFromGit,
            inheritableFields,
            readmeReplacementPath,
            replacePeerDepsWildcards,
            peerDepsVersionPrefix,
            logger,
            mergeFiles
          );
          if (result?.metadata) {
            if (verbose) {
              logger.info(
                `publish: Archive created successfully: ${result.packageFileName}`
              );
            }
            const archivePath = join(outputDir, result.packageFileName);
            return await runNpmPublish(
              archivePath,
              npmOptions,
              verbose,
              logger
            );
          } else {
            logger.error(
              `publish: Unable to find any files to pack: ${targetDir}`
            );
            return 1;
          }
        } finally {
          await rm(outputDir, { recursive: true, force: true });
        }
      } else {
        logger.error(
          `publish: Invalid path - must be a directory or .tgz/.tar.gz file: ${path}`
        );
        return 1;
      }
    } else {
      logger.error(`publish: Path does not exist: ${path}`);
      return 1;
    }
  } catch (error) {
    logger.error(`publish: Failed to publish: ${error}`);
    return 1;
  }
};

//////////////////////////////////////////////////////////////////////////////////

const showHelp = async () => {
  const { author, license, repository_url, version, git_commit_hash } =
    await import('./generated/packageMetadata.js');
  console.info(`screw-up [${version}-${git_commit_hash}]
Easy package metadata inserter CLI
Copyright (c) ${author}
Repository: ${repository_url}
License: ${license}

Usage: screw-up <command> [options]

Commands:
  format [output]                 Format text by replacing metadata placeholders
  dump [directory]                 Dump computed package.json as JSON
  metadata [directory]             Generate TypeScript metadata file
  pack [directory]                 Pack the project into a tar archive
  publish [directory|package.tgz]  Publish the project

Options:
  -h, --help                       Show help

Examples:
  screw-up format output.txt               # Format stdin template and write to file
  screw-up dump                            # Dump computed package.json as JSON
  screw-up metadata                        # Generate metadata file
  screw-up pack                            # Pack current directory
  screw-up pack --pack-destination ./dist  # Pack to specific output directory
  screw-up publish                         # Publish current directory
  screw-up publish package.tgz             # Publish existing tarball
`);
};

const argOptionMap = new Map([
  ['dump', new Set(['inheritable-fields'])],
  ['metadata', new Set(['output-metadata-file-path', 'output-metadata-keys'])],
  [
    'pack',
    new Set([
      'pack-destination',
      'readme',
      'inheritable-fields',
      'peer-deps-prefix',
    ]),
  ],
  ['format', new Set(['input', 'i', 'bracket', 'b', 'inheritable-fields'])],
  ['publish', new Set(['inheritable-fields', 'peer-deps-prefix'])],
]);

export const cliMain = async (
  args: string[],
  logger: Logger
): Promise<number> => {
  const parsedArgs = parseArgs(args, argOptionMap);

  // Handle global help or when no command is provided
  if (
    !parsedArgs.command &&
    (parsedArgs.options.help || parsedArgs.options.h)
  ) {
    await showHelp();
    return 1;
  }

  switch (parsedArgs.command) {
    case 'format':
      return await formatCommand(parsedArgs, logger);
    case 'dump':
      return await dumpCommand(parsedArgs, logger);
    case 'metadata':
      return await metadataCommand(parsedArgs, logger);
    case 'pack':
      return await packCommand(parsedArgs, logger);
    case 'publish':
      return await publishCommand(parsedArgs, logger);
    default:
      if (parsedArgs.command) {
        logger.error(`Unknown command: ${parsedArgs.command}`);
      } else {
        logger.error(`Unknown command`);
      }
      logger.error('Run "screw-up --help" for usage information.');
      return 1;
  }
};
