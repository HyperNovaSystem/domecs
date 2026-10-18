/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and a published build
 * carries the plain version. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export const BUILD_ID: string = 'dev'
