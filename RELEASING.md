# Releasing

Maintainers publish `@puppygraph/mcp-server` to npm by hand. The package lives in the `puppygraph` npm org. You need an npm account with publish rights in that org.

The version to publish is the `version` in `package.json` on `main`.

## 1. Check out a clean copy of main

Use a fresh clone, not a working copy with local changes.

```bash
git clone https://github.com/puppygraph/puppygraph-mcp-server.git
cd puppygraph-mcp-server
git log -1 --oneline
```

Check that the commit is the one you mean to release, and that CI passed on it.

## 2. Log in to npm

```bash
npm login
npm whoami
```

`npm whoami` must print an account in the `puppygraph` org.

## 3. Install, build and test

```bash
npm ci      # also builds build/ through the prepare script
npm test
```

All tests must pass.

## 4. Check the package contents

```bash
npm pack --dry-run
```

Expect `@puppygraph/mcp-server@<version>` with these files only:

- `LICENSE`
- `README.md`
- `package.json`
- `build/` (`index.js`, `server.js`, and the `clients/`, `services/`, `setup/` and `utils/` folders)

No `src/`, `tests/` or `node_modules/`. If the version or the files are wrong, stop.

## 5. Publish

```bash
npm publish --access public
```

If your account uses two-factor authentication, add `--otp=<code>`.

`npm publish` rebuilds through the `prepare` script. Scoped packages are private by default. `--access public` makes this one public; `publishConfig` in `package.json` sets it too.

## 6. Verify

```bash
npm view @puppygraph/mcp-server version
npx -y @puppygraph/mcp-server
```

`npm view` must print the new version. It can take a minute to show up. `npx` starts the server, which waits for an MCP client on stdin. Press Ctrl+C to exit.

## 7. Tag the release (optional)

```bash
git tag v<version>
git push origin v<version>
```

## 8. Bump the version for the next release

In a pull request:

```bash
npm version minor --no-git-tag-version
```

This updates `package.json` and `package-lock.json`. Also update the version that `src/server.ts` reports to MCP clients. Use `patch` instead of `minor` for a fix-only release.
