#!/usr/bin/env node

// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { program } from 'commander';
import { resolve } from 'path';
import { packAssets } from './cli-internal.js';

declare const __VERSION__: string;
declare const __AUTHOR__: string;
declare const __REPOSITORY_URL__: string;
declare const __LICENSE__: string;

//////////////////////////////////////////////////////////////////////////////////

program
  .name('screw-up')
  .description(`Easy package metadata inserter CLI [${__VERSION__}]`)
  .addHelpText('after', `
Copyright (c) ${__AUTHOR__}
Repository: ${__REPOSITORY_URL__}
License: ${__LICENSE__}
`);

//////////////////////////////////////////////////////////////////////////////////

program
  .command('pack [directory]')
  .description('Pack the project into a tar archive')
  .option('--pack-destination <path>', 'Directory to write the tarball')
  .action(async (directory?: string, options?: { packDestination?: string }) => {
    const targetDir = resolve(directory ?? process.cwd());
    const outputDir = options?.packDestination ? resolve(options.packDestination) : process.cwd();

    console.log(`[screw-up/cli]: pack: Creating archive of ${targetDir}...`);

    try {
      const result = await packAssets(targetDir, outputDir);
      if (result) {
        console.log(`[screw-up/cli]: pack: Archive created successfully: ${outputDir}`);
      } else {
        console.error(`[screw-up/cli]: pack: Unable to find any files to pack: ${targetDir}`);
        process.exit(1);
      }
    } catch (error) {
      console.error('[screw-up/cli]: pack: Failed to create archive:', error);
      process.exit(1);
    }
  });

//////////////////////////////////////////////////////////////////////////////////

program
  .command('publish')
  .description('Publish the project') 
  .action(() => {
    console.log('Hello World from publish command!');
  });

//////////////////////////////////////////////////////////////////////////////////

program.parse();
