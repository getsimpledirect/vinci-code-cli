// Integration check: exercise the REAL vinci-render `bashIntent` — the plain-language "what it's
// doing" label shown next to each shell command — so a run reads as intent, not raw shell. Node 23
// strips the type-only imports at load, so we can import the .ts (and its pi value-imports) directly.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { bashIntent, compactVinciDiff, compactVinciWrite, formatVinciToolLabel } = await import(
  resolve(here, "../extensions/vinci-render.ts")
);
assert.equal(typeof bashIntent, "function", "vinci-render must export bashIntent");
assert.equal(typeof compactVinciDiff, "function", "vinci-render must export compactVinciDiff");
assert.equal(typeof formatVinciToolLabel, "function", "vinci-render must export its central label formatter");

let pass = 0;
const is = (cmd, want) => {
  const got = bashIntent(cmd);
  assert.equal(got, want, `bashIntent(${JSON.stringify(cmd)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`  ✓ ${cmd}  →  ${want}`);
  pass++;
};

// File & folder poking
is("ls", "Looking through the files (ls)");
is("ls -la src", "Looking in src (ls -la src)");
is("ls -la path/to/components", "Looking in components (ls -la path/to/components)");
is("ls -la assets/", "Looking in assets (ls -la assets/)"); // retains the actual path, not only the gloss
is("cat package.json", "Reading package.json (cat package.json)");
is("head -20 README.md", "Reading README.md (head -20 README.md)");
is("grep -rn TODO .", "Searching the code (grep -rn TODO .)");
is("rg 'useState' src", "Searching the code (rg 'useState' src)");
is("find . -name '*.ts'", "Looking for files (find . -name '*.ts')");
is("tree src", "Mapping the folders (tree src)");
is("mkdir -p src/components", "Making a folder (mkdir -p src/components)");
is("touch src/index.ts", "Creating index.ts (touch src/index.ts)");
is("rm old.ts", "Deleting old.ts (rm old.ts)");
is("mv a.ts b.ts", "Moving / renaming (mv a.ts b.ts)");
is("cp a.ts b.ts", "Copying files (cp a.ts b.ts)");
is("wc -l *.ts", "Counting (wc -l *.ts)");
is("pwd", "Checking where we are (pwd)");

// npm / package managers — subcommand drives the label
is("npm install", "Installing packages (npm install)");
is("npm install lodash", "Installing packages (npm install lodash)");
is("npm i", "Installing packages (npm i)");
is("npm ci", "Installing packages (npm ci)");
is("pnpm add -D vitest", "Installing packages (pnpm add -D vitest)");
is("npm uninstall left-pad", "Removing a package (npm uninstall left-pad)");
is("npm run build", "npm build");
is("npm run test", "npm test");
is("npm test", "npm test");
is("npm run lint", "npm lint");
is("npm run dev", "npm dev");
is("yarn run typecheck", "yarn typecheck");
is("npm run e2e", "npm e2e");
is("pnpm typecheck", "pnpm typecheck");
is("pnpm test:nodejs", "pnpm test:nodejs");
is("pnpm --filter pkg run test", "pnpm test");
is("npm run -w pkg check", "npm check");
is("yarn workspace pkg test", "yarn test");
is("npx vitest", "npx vitest");
is("pnpm exec vitest", "pnpm vitest");
is("pnpm", "Running a command"); // genuinely unparseable: no subcommand or script
const longPackageLabel = formatVinciToolLabel(bashIntent(`pnpm run check:${"pathologically-long-script-name-".repeat(3)}`));
assert.equal(longPackageLabel.length, 60, "package labels must use the standard 60-character limit");
assert.match(longPackageLabel, /^pnpm check:/);
assert.match(longPackageLabel, /…$/);
console.log("  ✓ pathologically long package script labels are truncated to 60 characters");
pass++;
const longInstallLabel = formatVinciToolLabel(
  bashIntent(`npm install --save ${"pathologically-long-package-name-".repeat(3)}`)
);
assert.equal(longInstallLabel.length, 60, "composed install labels must use the standard 60-character limit");
assert.match(longInstallLabel, /^Installing packages \(/);
assert.match(longInstallLabel, /…$/);
console.log("  ✓ composed install labels are truncated to 60 characters");
pass++;

const oscCommand = `npm run te\x1b]0;hijacked title\x07st`;
assert.equal(formatVinciToolLabel(bashIntent(oscCommand)), "npm test");
console.log("  ✓ OSC title controls are removed from command-derived labels");
pass++;

const csiCommand = `npm run te\x1b[31mst`;
assert.equal(formatVinciToolLabel(bashIntent(csiCommand)), "npm test");
console.log("  ✓ CSI color controls are removed from command-derived labels");
pass++;

const longReadLabel = formatVinciToolLabel(`Read ${"nested-path-".repeat(8)}README.md`);
assert.equal(longReadLabel.length, 60, "long read labels must use the central 60-character limit");
assert.match(longReadLabel, /^Read /);
assert.match(longReadLabel, /…$/);
console.log("  ✓ long read labels are truncated centrally");
pass++;

const previousVinciCode = process.env.VINCI_CODE;
process.env.VINCI_CODE = "1";
try {
  const longMaskedLabel = formatVinciToolLabel(
    `Read sk-proj-abcd${"z".repeat(24)} ${"nested-path-".repeat(8)}`
  );
  assert.equal(longMaskedLabel.length, 60, "post-masking labels must use the central 60-character limit");
  assert.match(longMaskedLabel, /‹redacted›/);
  assert.match(longMaskedLabel, /…$/);
  console.log("  ✓ long post-masking labels are truncated centrally");
  pass++;
} finally {
  if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
  else process.env.VINCI_CODE = previousVinciCode;
}

// git — verb-by-verb, in the user's words
is("git status", "Checking what's changed (git status)");
is("git log --oneline -10", "Looking at the history (git log --oneline -10)");
is("git diff HEAD~1", "Reviewing the changes (git diff HEAD~1)");
is("git add -A", "Staging the changes (git add -A)");
is("git commit -m 'x'", "Saving a checkpoint (git commit -m 'x')");
is("git push origin vinci", "Pushing to the remote (git push origin vinci)");
is("git pull", "Getting the latest (git pull)");
is("git checkout -b feature", "Switching branches (git checkout -b feature)");
is("git stash", "Setting changes aside (git stash)");
is("git reset --hard", "Undoing changes (git reset --hard)");
is("git worktree add /tmp/x", "Working with worktrees (git worktree add /tmp/x)");
is("git frobnicate", "Working with git (git frobnicate)"); // unknown subcommand keeps the concrete action

// leading `cd … &&`, sudo, and env assignments are peeled so we describe the REAL command
is("cd /some/project && npm run build", "npm build");
is("cd src && ls", "Looking through the files (ls)");
is("sudo rm -rf build", "Deleting build (rm -rf build)");
is("NODE_ENV=production npm run build", "npm build");
is("FOO=1 BAR=2 node script.js", "Running a script (node script.js)");

// pipelines / chains describe the FIRST command
is("cat log.txt | grep error", "Reading log.txt (cat log.txt)");
is("git log | head", "Looking at the history (git log)");

// misc tools
is("curl https://api.example.com", "Fetching from the web (curl https://api.example.com)");
is("node build.js", "Running a script (node build.js)");
is("python3 train.py", "Running a script (python3 train.py)");
is("tsc --noEmit", "Type-checking (tsc --noEmit)");
is("docker build .", "Running Docker (docker build .)");
is("chmod +x run.sh", "Changing permissions (chmod +x run.sh)");
is("echo hi", "Printing a message (echo hi)");
is("echo 'x' > config.txt", "Writing to a file (echo 'x' > config.txt)"); // redirect → it's writing, not printing

// the safety net: anything we don't recognize stays a plain, honest label (no wrong guess)
is("some-obscure-binary --flag", "Running a command");
is("", "Running a command");
is("   ", "Running a command");

const editPreview = compactVinciDiff(
  "     ...\n  10 const mode = 'old';\n- 11 const label = 'quiet';\n+ 11 const label = 'lively';\n  12 export { label };\n  13 context\n  14 more context\n  15 final context",
  5,
);
assert.deepEqual(
  { added: editPreview?.added, removed: editPreview?.removed, truncated: editPreview?.truncated },
  { added: 1, removed: 1, truncated: true },
);
assert.match(editPreview?.text ?? "", /quiet/);
assert.match(editPreview?.text ?? "", /lively/);
console.log("  ✓ compact edit preview keeps red/green changes and reports hidden context");
pass++;

const writePreview = compactVinciWrite("first line\nsecond line\nthird line\n", 2);
assert.deepEqual(
  { added: writePreview?.added, removed: writePreview?.removed, truncated: writePreview?.truncated },
  { added: 3, removed: 0, truncated: true },
);
assert.match(writePreview?.text ?? "", /^\+\s*1 first line/m);
assert.doesNotMatch(writePreview?.text ?? "", /third line/);
console.log("  ✓ compact new-file preview reports additions and collapses overflow");
pass++;

// A heredoc body is file content, not command — it must never appear in a visible label, even
// though sanitization collapses the newlines that used to keep it off the label line.
const heredocLabel = bashIntent("cat > notes.txt <<'EOF'\nSSN 123-45-6789\nEOF");
assert.doesNotMatch(heredocLabel, /123-45|EOF/);
assert.match(heredocLabel, /cat > notes\.txt|Writing/);
console.log("  ✓ heredoc bodies never reach the visible label");
pass++;

// Only delimiter-shaped operators cut: a bit-shift is not a heredoc, and herestrings are.
assert.match(bashIntent("awk '{print 1<<2}' data.txt"), /awk/);
assert.doesNotMatch(bashIntent("awk '{print 1<<2}' data.txt"), /^Running a command$/);
assert.doesNotMatch(bashIntent("grep pattern file <<<'inline secret body'"), /inline secret/);
console.log("  ✓ bit-shifts keep their labels; herestring bodies stay hidden");
pass++;

// Heredoc-shaped text INSIDE a quoted string is literal content, not an operator.
assert.match(bashIntent("echo 'see <<EOF marker'"), /see <<EOF marker/);
assert.match(bashIntent('echo "note <<END here"'), /note <<END here/);
console.log("  ✓ quoted heredoc-shaped text is not cut");
pass++;

// ANSI-C quoting: inside $'…' a backslash escapes the quote, so the string ends at the REAL
// closing quote and a following unquoted heredoc must still cut — its body never reaches a label.
assert.doesNotMatch(bashIntent("cat $'safe\\'tail' <<EOF\nSECRET BODY\nEOF"), /SECRET/);
assert.match(bashIntent("echo $'see <<EOF marker'"), /see <<EOF marker/);
console.log("  ✓ ANSI-C quoting cannot hide a real heredoc, and quoted operators stay literal");
pass++;

// The body-leak invariant is structural: labels see only the first line (heredoc bodies always
// start after a newline) and nothing past <<<. No quoting construct can smuggle a body through.
assert.doesNotMatch(bashIntent('echo "$(echo \'"\')" <<EOF\nLEAK\nEOF'), /LEAK/);
assert.doesNotMatch(bashIntent("cat <<$'EOF'\nLEAK\nEOF"), /LEAK/);
assert.doesNotMatch(bashIntent("echo hi # '\ncat <<EOF\nLEAK\nEOF"), /LEAK/);
assert.doesNotMatch(bashIntent("cat <<\\EOF\nLEAK\nEOF"), /LEAK/);
assert.doesNotMatch(bashIntent("node -e 'x'\nSECOND LINE TAIL"), /SECOND LINE/);
console.log("  ✓ no quoting construct leaks a body: labels are first-line only");
pass++;

console.log(`\nrender-integration: ${pass}/${pass} checks passed (real bashIntent module)`);
