# Development

See this repository's [AGENTS.md](../../../AGENTS.md) and [contributing guide](../../../CONTRIBUTING.md) for development rules. These instructions use the Vinci Code checkout; the remaining sections describe the underlying Pi harness.

## Setup

```bash
git clone https://github.com/getsimpledirect/vinci-code-cli
cd vinci-code-cli
npm ci --ignore-scripts
bash vinci/build.sh
npm run check
```

Run Vinci Code from the checkout:

```bash
./vinci/bin/vinci
```

For Pi harness development, `/path/to/vinci-code-cli/pi-test.sh` can be run from any directory. Pi keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

From the repository root, use `./test.sh` for the non-LLM workspace tests. `npm run check` runs formatting, type and repository checks; it does not run tests.

For one coding-agent test, use Vitest from the package directory:

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/keybindings-migration.test.ts
```

The TUI package uses Node's built-in test runner instead of Vitest:

```bash
cd packages/tui # from the repository root
node --test test/keybindings.test.ts
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
