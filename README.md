# Screw-UP

Simply package metadata inserter for Vite plugins.

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/screw-up.svg)](https://www.npmjs.com/package/screw-up)

----

## What is this?

This is a Vite plugin that automatically inserts banner comments containing package metadata (name, version, description, author, license) into your bundled JavaScript/CSS files.

This will automatically read metadata from your `package.json`:

```json
{
  "name": "my-awesome-library",
  "version": "2.1.0",
  "description": "An awesome TypeScript library",
  "author": "Jane Developer <jane@example.com>",
  "license": "Apache-2.0"
}
```

To insert banner header each bundled source files (`dist/index.js` and etc.):

```javascript
/*!
 * my-awesome-library 2.1.0
 * An awesome TypeScript library
 * Author: Jane Developer <jane@example.com>
 * License: "Apache-2.0
 */
// Your bundled code here...
```

* Reads metadata from `package.json`.
* Supports both ESM and CommonJS outputs.
* Customizable banner templates.

## Installation

```bash
npm install --save-dev screw-up
```

----

## Usage

### Basic Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { screwUp } from 'screw-up';   // Need to this

export default defineConfig({
  plugins: [
    screwUp()   // Need to this
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'MyLibrary',
      fileName: 'index'
    }
  }
});
```

### Custom Banner Template

You can provide a custom banner template:

```typescript
import { defineConfig } from 'vite';
import { screwUp } from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      bannerTemplate: '/* My Custom Header - Built with ❤️ */'
    })
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'MyLibrary',
      fileName: 'index'
    }
  }
});
```

### Custom Package Path

Specify a different path to your package.json:

```typescript
import { defineConfig } from 'vite';
import { screwUp } from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      packagePath: './packages/core/package.json'
    })
  ]
});
```

## Advanced Usage

### Working with Monorepos

In monorepo setups, you might want to reference a specific package's metadata:

```typescript
import { defineConfig } from 'vite';
import { screwUp } from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      packagePath: '../../packages/ui/package.json'
    })
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'UILibrary',
      fileName: 'ui'
    }
  }
});
```

### Programmatic Banner Generation

You can also use the utility functions directly:

```typescript
import { generateBanner, readPackageMetadata } from 'screw-up';

// Read package metadata
const metadata = readPackageMetadata('./package.json');

// Generate banner
const banner = generateBanner({
  name: 'my-package',
  version: '1.0.0',
  description: 'A great package',
  author: 'Developer Name',
  license: 'MIT'
});

console.log(banner);
// /*!
//  * my-package v1.0.0
//  * A great package
//  * Author: Developer Name
//  * License: MIT
//  */
```

----

## License

Under MIT
