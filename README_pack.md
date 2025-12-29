# screw-up

Simply package metadata inserter for NPM.

![screw-up](images/screw-up-120.png)

[![Project Status: Active – The project has reached a stable, usable state and is being actively developed.](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What is this?

Looking for a simple solution to apply versions to TypeScript projects and NPM packages?
`screw-up` could be the tool you need.

It is a Vite plugin that automatically inserts banner comments containing package metadata (name, version, description, author, license, etc.) into bundled files, and a CLI tool that applies them to NPM packages.

The Vite plugin automatically reads metadata from `package.json`:

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

You may have noticed the line `git.commit.hash:`. That's right, if your project is managed by Git (it is, right?), you can also insert commit IDs, branch information, and tag information.
Most importantly, if a version is applied to a Git tag, you can automatically reflect that version tag in the `version` field of `package.json`. In other words, you can manage version numbers using only Git tags!

This calculates the version number by measuring the commit height to the current HEAD based on the last applied version tag.

![git-versioning](./images/git-versioning.png)

Instead of using `npm pack`, you can use the CLI tool `screw-up` to generate packages, which will automatically apply the collected metadata to the NPM package's `package.json`:

```bash
# Generate a package using `screw-up` command
$ screw-up pack
my-awesome-library-2.1.0.tgz
```

## Key Features

- Automatic metadata extraction: Reads metadata from `package.json` automatically.
- Workspace support: Works with monorepos and automatically inherits metadata from parent packages.
- Flexible output: Specify exactly which metadata to include and in what order.
- TypeScript metadata generation: Can automatically generates TypeScript files with metadata constants for use in your source code.
- Git metadata extraction: Automatically extracts Git commit hash, tags, branches, and version information from local Git repository.
- Supported pack/publish CLI interface: When publishing using this feature, the package is generated after applying the above processing to `package.json`.

---

## Documentation

[See the repository document](https://github.com/kekyo/screw-up/).

## Discussions and Pull Requests

For discussions, please refer to the [GitHub Discussions page](https://github.com/kekyo/screw-up/discussions). We have currently stopped issue-based discussions.

Pull requests are welcome! Please submit them as diffs against the `develop` branch and squashed changes before send.

## License

Under MIT.
