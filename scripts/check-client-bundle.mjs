// Fails when the browser entry point imports anything but the Zod-free part of the contract.
//
// `@gamebeast/sdk/client` must stay small: the contract's schemas (and classic Zod, ~90 KB gzipped)
// are for the server entry only. Type imports are erased, so a value import from
// `@gamebeast/sdk-contract` (the root) in code the client reaches is what this catches.
import { readFileSync } from "node:fs";

const ALLOWED = new Set(["@gamebeast/sdk-contract/core"]);
const ENTRIES = ["dist/client.js", "dist/client.cjs"];

let failed = false;
for (const entry of ENTRIES) {
  const source = readFileSync(entry, "utf8");
  const specifiers = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);

  for (const specifier of new Set(specifiers)) {
    if (specifier.startsWith(".") || ALLOWED.has(specifier)) continue;
    console.error(
      `${entry} imports "${specifier}"; the browser entry may only import ${[...ALLOWED].join(", ")}.`
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Browser entry imports only: ${[...ALLOWED].join(", ")}.`);
