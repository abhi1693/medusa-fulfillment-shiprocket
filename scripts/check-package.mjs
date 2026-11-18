
import assert from "node:assert/strict"
import { access, readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
async function check(value) {
  if (typeof value === "string" && !value.includes("*")) {
    await access(path.join(root, value))
  } else if (typeof value === "object") {
    for (const entry of Object.values(value)) await check(entry)
  }
}
await check(manifest.exports)
await check(manifest.types)
for (const directory of ["modules", "providers"]) {
  const base = path.join(root, ".medusa/server/src", directory)
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await access(path.join(base, entry.name, "index.js"))
    await access(path.join(base, entry.name, "index.d.ts"))
  }
}
assert.equal(manifest.license, "MIT")
await access(path.join(root, "LICENSE"))
await access(path.join(root, "scripts/ts-loader.mjs"))
console.log("Package exports, declarations, license and standalone test loader verified")
