# Screw-UP

Simply package metadata inserter for Vite plugins.

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/screw-up.svg)](https://www.npmjs.com/package/screw-up)

----

## What is this?

This is a Vite plugin that automatically inserts banner comments containing package metadata (name, version, description, author, license, etc.) into your bundled JavaScript/CSS files.

This will automatically read metadata from your `package.json`:

```json
{
  "name": "my-awesome-library",
  "version": "2.1.0",
  "description": "An awesome TypeScript library",
  "author": "Jane Developer <jane@example.com>",
  "license": "Apache-2.0",
  "repository": {
    "url": "https://github.com/user/my-awesome-library"
  }
}
```

To insert banner header each bundled source files (`dist/index.js` and etc.):

```javascript
/*!
 * name: my-awesome-library
 * version: 2.1.0
 * description: An awesome TypeScript library
 * author: Jane Developer <jane@example.com>
 * license: Apache-2.0
 * repository.url: https://github.com/user/my-awesome-library
 */
// Your bundled code here...
```

## Key Features

* Automatic metadata extraction: Reads metadata from `package.json` automatically.
* Workspace support: Works with monorepos and automatically inherits metadata from parent packages.
* Flexible output: Specify exactly which keys to include and in what order.
* Nested object support: Handles nested objects like `author.name`, `repository.url`.
* Customizable: Choose which metadata fields to include in your banner.

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
import { screwUp } from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp()  // Uses default output keys
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

### Custom Output Keys

You can specify which metadata fields to include and in what order:

```typescript
import { defineConfig } from 'vite';
import { screwUp } from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      outputKeys: ['name', 'version', 'license']  // Only include these fields
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

This will generate a banner with only the specified fields:

```javascript
/*!
 * name: my-awesome-library
 * version: 2.1.0
 * license: Apache-2.0
 */
```

#### Default Output Keys

When no `outputKeys` are specified, the plugin uses these default keys:

```typescript
['name', 'version', 'description', 'author', 'license', 'repository.url']
```

### Working with Nested Objects

The plugin automatically flattens nested objects using dot notation:

```json
{
  "name": "my-package",
  "author": {
    "name": "Jane Developer",
    "email": "jane@example.com"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/user/my-package"
  }
}
```

You can reference nested fields in your `outputKeys`:

```typescript
screwUp({
  outputKeys: ['name', 'author.name', 'author.email', 'repository.url']
})
```

Results in:

```javascript
/*!
 * name: my-package
 * author.name: Jane Developer
 * author.email: jane@example.com
 * repository.url: https://github.com/user/my-package
 */
```

----

## Advanced Usage

### Monorepo Support

The plugin automatically detects workspace configurations and inherits metadata from parent packages:

```
my-monorepo/
├── package.json          # Root package with shared metadata
├── packages/
│   ├── ui/
│   │   └── package.json  # Child package
│   └── core/
│       └── package.json  # Child package
```

Child packages automatically inherit metadata from the root package, with the ability to override specific fields:

```json
// Root package.json
{
  "name": "my-monorepo",
  "version": "1.0.0",
  "author": "Company Team",
  "license": "MIT"
}

// packages/ui/package.json
{
  "name": "@my-monorepo/ui",
  "description": "UI components library"
}
```

When building the UI package, the banner will include:

```javascript
/*!
 * name: @my-monorepo/ui
 * version: 1.0.0
 * description: UI components library
 * author: Company Team
 * license: MIT
 */
```

### Programmatic Usage

You can also use the utility functions directly:

```typescript
import { generateBanner, readPackageMetadata } from 'screw-up/internal';

// Read package metadata
const metadata = await readPackageMetadata('./package.json');

// Generate banner with custom keys
const banner = generateBanner(metadata, ['name', 'version', 'license']);

console.log(banner);
// /*!
//  * name: my-package
//  * version: 1.0.0
//  * license: MIT
//  */
```

## Supported Workspace Types

The plugin automatically detects and supports:

- npm/yarn workspaces: Detected via `workspaces` field in `package.json`
- pnpm workspaces: Detected via `pnpm-workspace.yaml` file
- Lerna: Detected via `lerna.json` file

----

## License

Under MIT