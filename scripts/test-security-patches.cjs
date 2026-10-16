const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");

// Exercise the installed build-tool dependency, including the pnpm patch.
const fromWeb = createRequire(
  path.join(__dirname, "../packages/local-web/package.json"),
);
const fromTailwind = createRequire(fromWeb.resolve("tailwindcss"));
const fromMicromatch = createRequire(fromTailwind.resolve("micromatch"));
const braces = fromMicromatch("braces");

for (const method of ["compile", "expand", "stringify"]) {
  for (const [open, close] of [
    ["{", "}"],
    ["(", ")"],
  ]) {
    const attack = `${open.repeat(4_000)}a,b${close.repeat(4_000)}`;
    assert.throws(() => braces[method](attack), {
      name: "SyntaxError",
      message: "Brace pattern nesting exceeds 128 levels",
    });
  }
}
assert.deepEqual(braces.expand("src/{local,remote}/**/*.{ts,tsx}"), [
  "src/local/**/*.ts",
  "src/local/**/*.tsx",
  "src/remote/**/*.ts",
  "src/remote/**/*.tsx",
]);
assert.equal(braces.stringify("\\{".repeat(1_000)), "{".repeat(1_000));
console.log(
  "Security patch: 6 malicious patterns rejected; ordinary and escaped patterns preserved.",
);
