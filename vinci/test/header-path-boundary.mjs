// Vinci Code header path boundary regression test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const source = resolve(fileURLToPath(new URL("..", import.meta.url)), "extensions/vinci-header.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { shortPath } = await loader.import(source, { default: false });

async function withHome(home, callback) {
  const previousHome = process.env.HOME;
  try {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    await callback();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

const home = join(sep, "Users", "alice");

test("shortPath abbreviates exact HOME", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(home, 40), "~");
  });
});

test("shortPath abbreviates a true HOME descendant", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(join(home, "project"), 40), `~${sep}project`);
  });
});

test("shortPath preserves a HOME descendant named dot-dot-cache", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(join(home, "..cache"), 40), `~${sep}..cache`);
  });
});

test("shortPath rejects an unrelated same-prefix sibling", async () => {
  await withHome(home, () => {
    const sibling = `${home}-other${sep}project`;
    assert.equal(shortPath(sibling, 40), sibling);
  });
});

test("shortPath leaves the HOME parent path unchanged", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(resolve(home, ".."), 40), resolve(home, ".."));
  });
});

test("shortPath leaves unrelated paths unchanged", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(join(sep, "opt", "project"), 40), join(sep, "opt", "project"));
  });
});

test("shortPath leaves paths unchanged when HOME is absent", async () => {
  await withHome(undefined, () => {
    assert.equal(shortPath(join(home, "project"), 40), join(home, "project"));
  });
});

test("shortPath keeps existing width truncation", async () => {
  await withHome(home, () => {
    assert.equal(shortPath(join(home, "projects", "very-long-name"), 12), "…y-long-name");
  });
});
