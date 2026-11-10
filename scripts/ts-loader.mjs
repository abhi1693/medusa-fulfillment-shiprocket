import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
]

export async function resolve(specifier, context, defaultResolve) {
  // Standard resolution first
  try {
    return await defaultResolve(specifier, context)
  } catch (err) {
    if (
      ["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(
        err.code
      ) &&
      (specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/"))
    ) {
      const parentPath = context.parentURL
        ? fileURLToPath(context.parentURL)
        : process.cwd()
      const baseDir = path.dirname(parentPath)
      const targetPath = path.resolve(baseDir, specifier)

      for (const ext of EXTENSIONS) {
        const candidate = targetPath + ext
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return defaultResolve(pathToFileURL(candidate).href, context)
        }
      }
    }
    throw err
  }
}
