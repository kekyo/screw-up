# screw-up

Simply package metadata inserter for Vite plugins.

![screw-up](images/screw-up-120.png)

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/screw-up.svg)](https://www.npmjs.com/package/screw-up)

----

[日本語はこちら](./README_ja.md)

## What is this?

This is a Vite plugin that automatically inserts banner comments containing package metadata (name, version, description, author, license, etc.) into your bundled files.

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
 * git.commit.hash: c94eaf71dcc6522aae593c7daf85bb745112caf0
 */
// Your bundled code here...
```

## Key Features

* Automatic metadata extraction: Reads metadata from `package.json` automatically.
* Workspace support: Works with monorepos and automatically inherits metadata from parent packages.
* Flexible output: Specify exactly which keys to include and in what order.
* Nested object support: Handles nested objects like `author.name`, `repository.url`.
* Customizable: Choose which metadata fields to include in your banner.
* TypeScript metadata generation: Can automatically generates TypeScript files with metadata constants for use in your source code.
* Git metadata extraction: Automatically extracts Git commit hash, tags, branches, and version information from local Git repository.
* Supported pack/publish CLI interface: When publishing using this feature, the package is generated after applying the above processing to `package.json`.

----

## Installation

Install as a `devDependencies` since Screw-UP does not require any runtime code.

```bash
npm install --save-dev screw-up
```

## Usage

The configuration method is described below.
If you want to quickly learn about recommended configurations and operation methods, refer to the "Recommended configuration" section.

### Setup the Vite plugin

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp()  // Uses default output keys
  ],
  // ...
});
```

When no `outputKeys` are specified, the plugin uses these metadata keys with exact sequence:
`name`, `version`, `description`, `author`, `license`, `repository.url` and `git.commit.hash`.

### Custom Output Keys

You can specify which metadata fields to include and in what order:

```typescript
import { defineConfig } from 'vite';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      outputKeys: ['name', 'version', 'license']  // Only include these fields
    })
  ],
  // ...
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

### Working with Nested Objects

The plugin automatically flattens nested objects using dot notation.
For example `package.json` declarations:

```json
{
  "name": "my-package",
  "author": {   // Nested metadata
    "name": "Jane Developer",
    "email": "jane@example.com"
  },
  "repository": {   // Nested metadata
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

### TypeScript Metadata Generation

The plugin can generate TypeScript files containing metadata constants that you can import and use in your source code:

```typescript
import { defineConfig } from 'vite';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      // Enable metadata file generation
      outputMetadataFile: true,
      // Custom path (optional)
      outputMetadataFilePath: 'src/generated/packageMetadata.ts',
      // Keys to include (optional)
      outputMetadataKeys: ['name', 'version', 'description', 'author', 'license']
    })
  ],
  // ...
});
```

This generates `src/generated/packageMetadata.ts` with TypeScript constants:

```typescript
// This file is auto-generated by screw-up plugin
// Do not edit manually

export const name = "my-awesome-library";
export const version = "2.1.0";
export const description = "An awesome TypeScript library";
export const author = "Jane Developer <jane@example.com>";
export const license = "Apache-2.0";
```

You can then import and use these constants in your source code:

```typescript
import { name, version } from './generated/packageMetadata.js';

// Output: my-awesome-library v2.1.0
console.log(`${name} v${version}`);

export function getLibraryInfo() {
  return { name, version };
}
```

#### Key Sanitization

Keys with special characters are automatically sanitized to valid TypeScript identifiers:

- `repository.url` → `repository_url`
- `custom-key` → `custom_key`
- `123invalid` → `_123invalid`

### Git Metadata

The plugin automatically extracts Git metadata from your local Git repository and makes it available as metadata keys.

#### Available Git Metadata

- `git.version`: Automatically calculated version based on Git tags and commit depth
- `git.commit.hash`: Full commit hash of the current commit
- `git.commit.short`: Short commit hash (first 7 characters)
- `git.commit.date`: Commit date in ISO format
- `git.commit.message`: Commit message
- `git.tags`: Array of all tags pointing to the current commit
- `git.branches`: Array of branches containing the current commit

#### Version Calculation

The Git version calculation follows below algorithm:

1. Tagged commits: Uses the tag version directly (e.g., `v1.2.3` --> `1.2.3`)
2. Untagged commits: Detects depth from the furthest ancestor tag and increments the last version component
3. Modified working directory: When uncommitted changes exist, increments the version by one
4. No tags found: Defaults to `0.0.1` and increments for each commit

Additionally, this calculated version is applied as the default value for the `version` key in `package.json`. Therefore, you can manage version number using Git tags and Screw-UP without including the `version` key in `package.json`.

Example with Git metadata:

```typescript
screwUp({
  outputKeys: ['name', 'version', 'git.version', 'git.commit.hash', 'git.commit.short']
})
```

Results in:

```javascript
/*!
 * name: my-awesome-library
 * version: 2.1.0
 * git.version: 1.2.4
 * git.commit.hash: c94eaf71dcc6522aae593c7daf85bb745112caf0
 * git.commit.short: c94eaf7
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

## Supported Workspace Types

The plugin automatically detects and supports:

- npm/yarn workspaces: Detected via `workspaces` field in `package.json`
- pnpm workspaces: Detected via `pnpm-workspace.yaml` file
- Lerna: Detected via `lerna.json` file

----

## CLI Usage

The `screw-up` package includes a command-line interface for packaging and publishing your projects.

### Examples

```bash
# Build and publish with dry run
screw-up publish --dry-run

# Publish to beta channel
screw-up publish --tag beta

# Publish scoped package as public
screw-up publish --access public

# Pack with custom README and limited inheritance
screw-up pack --readme ./docs/DIST_README.md --inheritable-fields "version,license"

# Pack with custom peerDependencies prefix
screw-up pack --peer-deps-prefix "~"

# Pack without peerDependencies replacement
screw-up pack --no-replace-peer-deps

# Debug package resolution
screw-up dump --inheritable-fields "version,author"

# Pack to custom directory then publish
screw-up pack --pack-destination ./release
screw-up publish ./release/my-package-1.0.0.tgz
```

For help with any command:

```bash
screw-up --help
screw-up dump --help
screw-up pack --help
screw-up publish --help
```

### Pack Command

Create a tar archive of your project:

```bash
# Pack current directory
screw-up pack

# Pack specific directory
screw-up pack ./my-project

# Pack to specific output directory
screw-up pack --pack-destination ./dist
```

The pack command:

- Automatically reads `package.json` for metadata and file inclusion rules
- Respects the `files` field in your `package.json`
- Supports workspace inheritance (inherits metadata from parent packages)
- Creates a compressed `.tgz` archive with format: `{name}-{version}.tgz`

#### Options

- `--pack-destination <path>`: Specify output directory for the archive
- `--readme <path>`: Replace README.md with specified file
- `--inheritable-fields <list>`: Comma-separated list of fields to inherit from parent (default: version,description,author,license,repository,keywords,homepage,bugs,readme)
- `--no-wds`: Disable working directory status check for version increment
- `--no-replace-peer-deps`: Disable replacing "*" in peerDependencies with actual versions
- `--peer-deps-prefix <prefix>`: Version prefix for replaced peerDependencies (default: "^")

### Publish Command

Publish your project to registry server:

```bash
# Publish current directory (creates archive and publishes)
screw-up publish

# Publish specific directory
screw-up publish ./my-project

# Publish existing tarball
screw-up publish package.tgz

# Publish with npm options (all npm publish options are supported)
screw-up publish --dry-run --tag beta --access public
```

The publish command:

- Supports all `npm publish` options transparently. This command creates an archive and then executes the actual publishing by calling `npm publish`.
- Can publish from directory (automatically creates archive) or existing tarball
- Handles workspace packages with proper metadata inheritance
- Uses the same packaging logic as the pack command

#### Options

- `--inheritable-fields <list>`: Comma-separated list of fields to inherit from parent
- `--no-wds`: Disable working directory status check for version increment
- `--no-replace-peer-deps`: Disable replacing "*" in peerDependencies with actual versions
- `--peer-deps-prefix <prefix>`: Version prefix for replaced peerDependencies (default: "^")
- All `npm publish` options are supported (e.g., `--dry-run`, `--tag`, `--access`, `--registry`)

### Dump Command

Dump computed package.json as JSON:

```bash
# Dump current directory package.json
screw-up dump

# Dump specific directory package.json
screw-up dump ./my-project

# Dump with custom inheritable fields
screw-up dump --inheritable-fields "author,license"
```

The dump command:

- Shows the final computed `package.json` after all processing (workspace inheritance, Git metadata, etc.)
- Useful for debugging and understanding how your package metadata will be resolved
- Outputs clean JSON that can be piped to other tools

#### Options

- `--inheritable-fields <list>`: Comma-separated list of fields to inherit from parent
- `--no-wds`: Disable working directory status check for version increment

### PeerDependencies Replacement

In workspace environments, it's common to reference sibling packages using "*" in `peerDependencies` to avoid version constraints during development. When packaging, Screw-UP automatically replaces these wildcards with actual version numbers:

```json
{
  "name": "@workspace/cli",
  "peerDependencies": {
    "@workspace/core": "*"
  }
}
```

After packaging, the "*" is replaced with the actual version:

```json
{
  "name": "@workspace/cli", 
  "peerDependencies": {
    "@workspace/core": "^2.1.0"
  }
}
```

#### Controlling the Feature

```bash
# Default behavior (uses "^" prefix)
screw-up pack

# Disable the feature entirely
screw-up pack --no-replace-peer-deps

# Use different version prefix
screw-up pack --peer-deps-prefix "~"
screw-up pack --peer-deps-prefix ">="

# Use exact version (no prefix)
screw-up pack --peer-deps-prefix ""
```

This feature:
- Only works in workspace environments (requires workspace root with `workspaces` field)
- Only replaces "*" values that match workspace sibling package names
- Leaves non-workspace dependencies unchanged
- Is enabled by default for pack and publish commands

### README Replacement

The pack command supports README replacement using multiple methods:

#### Via CLI Option

```bash
# Replace README.md with custom file
screw-up pack --readme ./docs/README_package.md
```

#### Via package.json Field

```json
{
  "name": "my-package",
  "readme": "docs/PACKAGE_README.md"
}
```

When both are specified, the `--readme` CLI option takes priority over the `package.json` field.

### Workspace Field Inheritance

Control which metadata fields are inherited from parent packages in monorepos:

```bash
# Inherit only specific fields
screw-up pack --inheritable-fields "version,author,license"

# Disable inheritance completely
screw-up pack --inheritable-fields ""

# Use custom fields for publishing
screw-up publish --inheritable-fields "version,description,keywords"
```

Default inheritable fields: `version`, `description`, `author`, `license`, `repository`, `keywords`, `homepage`, `bugs`, `readme`

----

## Recommended configuration

screw-up allows you to keep your development lifecycle simple.
Below are typical configurations for single projects and monorepos using workspaces.

### Single project configuration

For standalone projects, follow these recommendations for optimal Screw-UP usage:

```
my-project/
├── package.json                 # No version field
├── README.md                    # Development README (show in github/gitlab)
├── README_pack.md               # Distribution README (optional)
├── vite.config.ts               # Screw-UP plugin configuration
├── src/
│   ├── index.ts
│   └── generated/
│       └── packageMetadata.ts   # Auto-generated by `outputMetadataFile`
└── dist/                        # Build output with metadata banners
```

#### Package.json structure

```json
{
  "name": "my-awesome-library",
  "description": "An awesome TypeScript library for developers",
  "author": "Jane Developer <jane@example.com>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/user/my-awesome-library"
  },
  "keywords": ["typescript", "library", "awesome"],
  "homepage": "https://github.com/user/my-awesome-library#readme",
  "bugs": {
    "url": "https://github.com/user/my-awesome-library/issues"
  },
  "readme": "README_pack.md",
  "files": ["dist/**/*", "README_pack.md"],
  "scripts": {
    "build": "vite build",
    "test": "npm run build && vitest run",
    "pack": "npm run build && screw-up pack --pack-destination artifacts/"
  }
}
```

Key Points:

- Remove `version`: Let Screw-UP manage versioning through Git tags
- Include metadata fields: `name`, `description`, `author`, `license`, etc.
- Optional `readme` field: Point to a distribution-specific README file
- Specify `files`: Control which files are included in the package
- Add `pack` to `scripts` to enable packaging with screw-up.

#### Vite configuration

```typescript
import { defineConfig } from 'vite';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    screwUp({
      // (Generate `packageMetadata.ts` when you need it)
      outputMetadataFile: true
    })
  ],
  // ...
});
```

#### Development setup

```bash
# Install as dev dependency
npm install --save-dev screw-up

# Create distribution README (optional)
echo "# Distribution Package" > README_pack.md
```

### Workspace configuration (Monorepo)

For monorepo setups, organize shared and project-specific metadata:

```
my-monorepo/
├── package.json          # Root metadata (no version)
├── README.md             # Development README (show in GitHub/GitLab)
├── README_shared.md      # Shared README
├── core/
│   ├── package.json      # Project-specific metadata (no version)
│   ├── vite.config.ts
│   └── src/
├── ui/
│   ├── package.json      # References core with "*" (no version)
│   └── src/
└── cli/
    ├── package.json      # References core with "*" (no version)
    └── src/
```

#### Root package.json

```json
{
  "name": "my-monorepo",
  "description": "Monorepo containing multiple packages",
  "author": "Development Team <team@company.com>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/company/my-monorepo"
  },
  "homepage": "https://github.com/company/my-monorepo#readme",
  "bugs": {
    "url": "https://github.com/company/my-monorepo/issues"
  },
  "readme": "README_shared.md",
  "workspaces": ["core", "ui", "cli"],
  "private": true,
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "pack": "npm run pack --workspaces"
  }
}
```

#### Sub-project package.json

```json
{
  "name": "@company/ui-components",
  "description": "Reusable UI components library",
  "keywords": ["ui", "components", "react"],
  "peerDependencies": {
    "@company/core": "*",
    "react": "^18.0.0"
  },
  "files": ["dist/**/*"],
  "scripts": {
    "build": "vite build",
    "test": "npm run build && vitest run",
    "pack": "npm run build && screw-up pack --pack-destination artifacts/"
  }
}
```

Key Points:

- Root package: Define shared metadata (`author`, `license`, `repository`, etc.)
- Sub-projects: Override with project-specific values (`name`, `description`, `keywords`)
- Sibling references: Use `"*"` in `peerDependencies` for workspace siblings when you need to refer on peer
- No versions: Remove `version` from all package.json files
- Shared README: Can be defined at root level and inherited by sub-projects

#### Vite configuration

Same as single project configuration.

#### Development Environment Setup

Install screw-up in each sub project.

#### CLI usage examples

```bash
# Pack individual sub-project
screw-up pack packages/ui-components

# Pack with custom inheritance
screw-up pack packages/cli --inheritable-fields "author,license,repository"

# Pack without peerDependencies replacement
screw-up pack packages/plugin --no-replace-peer-deps

# Publish with custom prefix
screw-up publish packages/core --peer-deps-prefix "~"
```

----

## Note

This project was developed as a successor to [RelaxVersioner](https://github.com/kekyo/RelaxVersioner/).
While RelaxVersioner was designed for the .NET platform and added NPM support options, it did not integrate well with Git tags.
Therefore, this project was designed with Vite plugin usage in mind, focusing on the most optimal workflow and specifications.

## License

Under MIT
