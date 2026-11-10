import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))
const pack = Array.isArray(result) ? result[0] : Object.values(result)[0]
const files = new Set(pack.files.map((file) => file.path))
for (const file of ["LICENSE", "source.json", "README.md", "scripts/ts-loader.mjs", "src/tests/auth.test.ts", ".medusa/server/src/providers/shiprocket/index.js", ".medusa/server/src/providers/shiprocket/index.d.ts", ".medusa/server/src/admin/index.mjs"]) assert(files.has(file), `Missing package file: ${file}`)
for (const file of files) assert(!/(^|\/)\.env(?:$|\.)/.test(file), `Environment file in package: ${file}`)
assert.equal(pack.name, "@abhi1693/medusa-fulfillment-shiprocket")
console.log(`Verified ${files.size} tarball entries, source/tests, runtime/types/Admin exports and license; no publication`)
