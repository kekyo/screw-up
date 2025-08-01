#!/usr/bin/env node

// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { cliMain } from './cli.js';
import { createConsoleLogger } from './internal.js';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

const logger = createConsoleLogger();

cliMain(
  process.argv.slice(2),  // Remove 'node' and script path
  logger).
  then(code => process.exit(code)).
  catch(error => {
    logger.error(`CLI error: ${error}`);
    process.exit(1);
  });
