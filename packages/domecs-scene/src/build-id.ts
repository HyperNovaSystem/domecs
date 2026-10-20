/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and `pnpm publish:npm`
 * stamps the plain version (`scripts/stamp-build-id.mjs`), so a published
 * build carries it. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export const BUILD_ID: string = 'dev'
