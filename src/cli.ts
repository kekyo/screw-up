// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { packAssets, parseArgs, ParsedArgs, getComputedPackageJsonObject } from './cli-internal';
import { getFetchGitMetadata } from './analyzer';
import { Logger } from './internal';

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
  'readme'
]);

// Parse inheritable fields from CLI option string
const parseInheritableFields = (inheritableFieldsOption: string | boolean | undefined): Set<string> => {
  if (typeof inheritableFieldsOption !== 'string') {
    return defaultInheritableFields;
  }
  if (!inheritableFieldsOption.trim()) {
    return new Set(); // Empty set for empty string (no inheritance)
  }
  return new Set(inheritableFieldsOption.
    split(',').
    map(field => field.trim()).
    filter(field => field.length > 0));
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

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);

  const targetDir = resolve(directory ?? process.cwd());

  // The dump command needs clean output, so ignore debug/info/warn outputs.
  const _logger: Logger = {
    debug: msg => {},
    info: msg => {},
    warn: msg => {},
    error: logger.error,
  };

  try {
    // Get Git metadata fetcher function
    const fetchGitMetadata = getFetchGitMetadata(
      targetDir, checkWorkingDirectoryStatus, _logger);

    // Resolve package metadata
    const computedPackageJson = await getComputedPackageJsonObject(
      targetDir, fetchGitMetadata, alwaysOverrideVersionFromGit, inheritableFields, _logger);

    if (computedPackageJson) {
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
  const replacePeerDepsWildcards = !args.options['no-replace-peer-deps'];
  const peerDepsVersionPrefix = args.options['peer-deps-prefix'] as string ?? "^";
  const verbose = args.options['verbose'] ? true : false;

  const targetDir = resolve(directory ?? process.cwd());
  const outputDir = packDestination ? resolve(packDestination) : process.cwd();
  const readmeReplacementPath = readmeOption ? resolve(readmeOption) : undefined;
  
  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);

  if (verbose) {
    logger.info(`pack: Creating archive of ${targetDir}...`);
  }

  try {
    const result = await packAssets(
      targetDir, outputDir,
      checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit,
      inheritableFields,
      readmeReplacementPath,
      replacePeerDepsWildcards, peerDepsVersionPrefix, logger);
    if (result) {
      if (verbose) {
        logger.info(`pack: Archive created successfully: ${result.packageFileName}`);
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
  tarballPath: string, npmOptions: string[], verbose: boolean, logger: Logger) => {
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
    npmProcess.on('close', code => {
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
  const replacePeerDepsWildcards = !args.options['no-replace-peer-deps'];
  const peerDepsVersionPrefix = args.options['peer-deps-prefix'] as string ?? "^";
  const verbose = args.options['verbose'] ? true : false;

  // Parse inheritable fields from CLI option or use defaults
  const inheritableFields = parseInheritableFields(inheritableFieldsOption);
  const readmeReplacementPath = readmeOption ? resolve(readmeOption) : undefined;

  // Aggregate npm options, except screw-up options.
  const npmOptions: string[] = [];
  for (let i = 0; i < args.argv.length; i++) {
    const arg = args.argv[i];
    if (arg === 'publish') {
      // Skip the command itself
    } else if (arg === '--help' || arg === '--verbose' ||  arg === '-h' ||arg === '--no-wds' ||
        arg === '--no-git-version-override' || arg === '--no-replace-peer-deps') {
    } else if (arg === '--readme' || arg === '--inheritable-fields' || arg === '--peer-deps-prefix') {
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
          targetDir, outputDir,
          checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit,
          inheritableFields,
          readmeReplacementPath,
          replacePeerDepsWildcards, peerDepsVersionPrefix, logger);
        if (result?.metadata) {
          if (verbose) {
            logger.info(`publish: Archive created successfully: ${result.packageFileName}`);
          }
          const archivePath = join(outputDir, result.packageFileName);
          return await runNpmPublish(archivePath, npmOptions, verbose, logger);
        } else {
          logger.error(`publish: Unable to find any files to pack: ${targetDir}`);
          return 1;
        }
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    } else if (existsSync(path)) {
      const pathStat = await stat(path);
      
      if (pathStat.isFile() && (path.endsWith('.tgz') || path.endsWith('.tar.gz'))) {
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
            targetDir, outputDir,
            checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit,
            inheritableFields,
            readmeReplacementPath,
            replacePeerDepsWildcards, peerDepsVersionPrefix, logger);
          if (result?.metadata) {
            if (verbose) {
              logger.info(`publish: Archive created successfully: ${result.packageFileName}`);
            }
            const archivePath = join(outputDir, result.packageFileName);
            return await runNpmPublish(archivePath, npmOptions, verbose, logger);
          } else {
            logger.error(`publish: Unable to find any files to pack: ${targetDir}`);
            return 1;
          }
        } finally {
          await rm(outputDir, { recursive: true, force: true });
        }
      } else {
        logger.error(`publish: Invalid path - must be a directory or .tgz/.tar.gz file: ${path}`);
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
  const { author, license, repository_url, version, git_commit_hash } = await import('./generated/packageMetadata.js');
  console.info(`screw-up [${version}-${git_commit_hash}]
Easy package metadata inserter CLI
Copyright (c) ${author}
Repository: ${repository_url}
License: ${license}

Usage: screw-up <command> [options]

Commands:
  dump [directory]                 Dump computed package.json as JSON
  pack [directory]                 Pack the project into a tar archive
  publish [directory|package.tgz]  Publish the project

Options:
  -h, --help                       Show help

Examples:
  screw-up dump                            # Dump computed package.json as JSON
  screw-up pack                            # Pack current directory
  screw-up pack --pack-destination ./dist  # Pack to specific output directory
  screw-up publish                         # Publish current directory
  screw-up publish package.tgz             # Publish existing tarball
`);
};

const argOptionMap = new Map([
  ['dump', new Set(['inheritable-fields'])],
  ['pack', new Set(['pack-destination', 'readme', 'inheritable-fields', 'peer-deps-prefix'])],
  ['publish', new Set(['inheritable-fields', 'peer-deps-prefix'])],
]);

export const cliMain = async (args: string[], logger: Logger): Promise<number> => {
  const parsedArgs = parseArgs(args, argOptionMap);

  // Handle global help or when no command is provided
  if (!parsedArgs.command && (parsedArgs.options.help || parsedArgs.options.h)) {
    await showHelp();
    return 1;
  }

  switch (parsedArgs.command) {
    case 'dump':
      return await dumpCommand(parsedArgs, logger);
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
