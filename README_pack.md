# screw-up

Simply package metadata inserter for Vite plugins.

![screw-up](images/screw-up-120.png)

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

----

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

## Documentation

[See the repository](https://github.com/kekyo/screw-up/)

## License

Under MIT.
