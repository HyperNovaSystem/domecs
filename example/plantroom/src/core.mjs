/**
 * Built @domecs/core for the headless Plantroom modules: the workspace's
 * dist when run from the engine repo, else the installed package (as when
 * release validation stages the example against packed tarballs).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const local = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/domecs/dist/index.js')

export const core = existsSync(local)
  ? await import(pathToFileURL(local).href)
  : await import('@domecs/core')
