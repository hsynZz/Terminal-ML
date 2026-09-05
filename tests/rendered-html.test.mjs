import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("uses production terminal metadata", async () => {
  const layout = await readFile(`${root}/app/layout.tsx`, "utf8");
  assert.match(layout, /FX Macro Dominance Terminal/);
  assert.match(layout, /lang="de"/);
  assert.doesNotMatch(layout, /codex-preview/);
  assert.doesNotMatch(layout, /Starter Project/);
});
