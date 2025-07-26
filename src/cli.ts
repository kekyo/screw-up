#!/usr/bin/env node

// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { packAssets, parseArgs, ParsedArgs, getComputedPackageJsonObject } from './cli-internal.js';

declare const __VERSION__: string;
declare const __AUTHOR__: string;
declare const __REPOSITORY_URL__: string;
declare const __LICENSE__: string;

//////////////////////////////////////////////////////////////////////////////////

const showHelp = () => {
  console.log(`screw-up - Easy package metadata inserter CLI [${__VERSION__}]
Copyright (c) ${__AUTHOR__}
Repository: ${__REPOSITORY_URL__}
License: ${__LICENSE__}

Usage: screw-up <command> [options]

Commands:
  pack [directory]              Pack the project into a tar archive
  publish [directory|package.tgz]  Publish the project
  dump [directory]              Dump computed package.json as JSON

Options:
  -h, --help                    Show help

Pack Options:
  --pack-destination <path>     Directory to write the tarball
  --no-wds                      Do not check working directory status to increase version

Publish Options:
  All npm publish options are supported (e.g., --dry-run, --tag, --access, --registry)

Examples:
  screw-up pack                            # Pack current directory
  screw-up pack ./my-project               # Pack specific directory
  screw-up pack --pack-destination ./dist  # Pack to specific output directory
  screw-up pack --readme ./README_pack.md  # Pack with custom README
  screw-up publish                         # Publish current directory
  screw-up publish ./my-project            # Publish specific directory
  screw-up publish package.tgz             # Publish existing tarball
  screw-up publish --dry-run --tag beta    # Publish with npm options
`);
};

const showPackHelp = () => {
  console.log(`Usage: screw-up pack [options] [directory]

Pack the project into a tar archive

Arguments:
  directory                     Directory to pack (default: current directory)

Options:
  --pack-destination <path>     Directory to write the tarball
  --readme <path>               Replace README.md with specified file
  --no-wds                      Do not check working directory status to increase version
  -h, --help                    Show help for pack command
`);
};

const showPublishHelp = () => {
  console.log(`Usage: screw-up publish [options] [directory|package.tgz]

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

//////////////////////////////////////////////////////////////////////////////////

const packCommand = async (args: ParsedArgs) => {
  if (args.options.help || args.options.h) {
    showPackHelp();
    return;
  }

  const directory = args.positional[0];
  const packDestination = args.options['pack-destination'] as string;
  const readmeOption = args.options['readme'] as string;
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;

  const targetDir = resolve(directory ?? process.cwd());
  const outputDir = packDestination ? resolve(packDestination) : process.cwd();
  const readmeReplacementPath = readmeOption ? resolve(readmeOption) : undefined;

  console.log(`[screw-up/cli]: pack: Creating archive of ${targetDir}...`);

  try {
    const metadata = await packAssets(
      targetDir, outputDir, checkWorkingDirectoryStatus, undefined, readmeReplacementPath);
    if (metadata) {
      console.log(`[screw-up/cli]: pack: Archive created successfully: ${outputDir}`);
    } else {
      console.error(`[screw-up/cli]: pack: Unable to find any files to pack: ${targetDir}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('[screw-up/cli]: pack: Failed to create archive:', error);
    process.exit(1);
  }
};

//////////////////////////////////////////////////////////////////////////////////

const publishCommand = async (args: ParsedArgs) => {
  if (args.options.help || args.options.h) {
    showPublishHelp();
    return;
  }

  const runNpmPublish = async (tarballPath: string, npmOptions: string[]) => {
    console.log(`[screw-up/cli]: publish: Publishing ${tarballPath} to npm...`);
    
    const publishArgs = ['publish', tarballPath, ...npmOptions];
    
    // For testing: log the command that would be executed
    if (process.env.SCREW_UP_TEST_MODE === 'true') {
      console.log(`[screw-up/cli]: TEST_MODE: Would execute: npm ${publishArgs.join(' ')}`);
      console.log(`[screw-up/cli]: TEST_MODE: Tarball path: ${tarballPath}`);
      console.log(`[screw-up/cli]: TEST_MODE: Options: ${npmOptions.join(' ')}`);
      console.log(`[screw-up/cli]: publish: Successfully published ${tarballPath}`);
      return;
    }
    
    const npmProcess = spawn('npm', publishArgs, { stdio: 'inherit' });
    
    return new Promise<void>((resolve, reject) => {
      npmProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[screw-up/cli]: publish: Successfully published ${tarballPath}`);
          resolve();
        } else {
          reject(new Error(`npm publish failed with exit code ${code}`));
        }
      });
      npmProcess.on('error', reject);
    });
  };

  const path = args.positional[0];
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;

  // Convert parsed options to npm options
  const npmOptions: string[] = [];
  Object.entries(args.options).forEach(([key, value]) => {
    if (key === 'help' || key === 'h' || key === 'no-wds') return; // Skip help and no-wds options

    if (value === true) {
      npmOptions.push(`--${key}`);
    } else {
      npmOptions.push(`--${key}`, value as string);
    }
  });

  try {
    if (!path) {
      // No argument provided - generate tarball from current directory and publish
      const targetDir = process.cwd();
      const outputDir = await mkdtemp('screw-up-publish-');

      console.log(`[screw-up/cli]: publish: Creating archive of ${targetDir}...`);

      try {
        const metadata = await packAssets(
          targetDir, outputDir, checkWorkingDirectoryStatus);
        if (metadata) {
          const archiveName = `${metadata.name}-${metadata.version}.tgz`;
          const archivePath = join(outputDir, archiveName);
          await runNpmPublish(archivePath, npmOptions);
        } else {
          console.error(`[screw-up/cli]: publish: Unable to find any files to pack: ${targetDir}`);
          process.exit(1);
        }
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    } else if (existsSync(path)) {
      const pathStat = await stat(path);
      
      if (pathStat.isFile() && (path.endsWith('.tgz') || path.endsWith('.tar.gz'))) {
        // Argument is a tarball file - publish directly
        await runNpmPublish(resolve(path), npmOptions);
      } else if (pathStat.isDirectory()) {
        // Argument is a directory - generate tarball from directory and publish
        const targetDir = resolve(path);
        const outputDir = await mkdtemp('screw-up-publish-');

        console.log(`[screw-up/cli]: publish: Creating archive of ${targetDir}...`);

        try {
          const metadata = await packAssets(
            targetDir, outputDir, checkWorkingDirectoryStatus);
          if (metadata) {
            const archiveName = `${metadata.name}-${metadata.version}.tgz`;
            const archivePath = join(outputDir, archiveName);
            await runNpmPublish(archivePath, npmOptions);
          } else {
            console.error(`[screw-up/cli]: publish: Unable to find any files to pack: ${targetDir}`);
            process.exit(1);
          }
        } finally {
          await rm(outputDir, { recursive: true, force: true });
        }
      } else {
        console.error(`[screw-up/cli]: publish: Invalid path - must be a directory or .tgz/.tar.gz file: ${path}`);
        process.exit(1);
      }
    } else {
      console.error(`[screw-up/cli]: publish: Path does not exist: ${path}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('[screw-up/cli]: publish: Failed to publish:', error);
    process.exit(1);
  }
};

const showDumpHelp = () => {
  console.log(`Usage: screw-up dump [options] [directory]

Dump computed package.json as JSON

Arguments:
  directory                     Directory to dump package.json from (default: current directory)

Options:
  --no-wds                      Do not check working directory status to increase version
  -h, --help                    Show help for dump command
`);
};

//////////////////////////////////////////////////////////////////////////////////

const dumpCommand = async (args: ParsedArgs) => {
  if (args.options.help || args.options.h) {
    showDumpHelp();
    return;
  }

  const directory = args.positional[0];
  const checkWorkingDirectoryStatus = args.options['no-wds'] ? false : true;

  const targetDir = resolve(directory ?? process.cwd());

  try {
    const computedPackageJson = await getComputedPackageJsonObject(
      targetDir, checkWorkingDirectoryStatus);
    if (computedPackageJson) {
      console.log(JSON.stringify(computedPackageJson, null, 2));
    } else {
      console.error(`[screw-up/cli]: dump: Unable to read package.json from: ${targetDir}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('[screw-up/cli]: dump: Failed to dump package.json:', error);
    process.exit(1);
  }
};

//////////////////////////////////////////////////////////////////////////////////

const main = async () => {
  const args = parseArgs(process.argv);

  // Handle global help or when no command is provided
  if (args.options.help || args.options.h || !args.command || 
      args.command === 'help' || args.command === '--help') {
    showHelp();
    return;
  }

  switch (args.command) {
    case 'pack':
      await packCommand(args);
      break;
    case 'publish':
      await publishCommand(args);
      break;
    case 'dump':
      await dumpCommand(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      console.error('Run "screw-up --help" for usage information.');
      process.exit(1);
  }
};

main().catch((error) => {
  console.error('CLI error:', error);
  process.exit(1);
});
