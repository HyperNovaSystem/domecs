# DOMECS Findings - Vite Template

Notes from building out `domecs_template_vite` as the official app template.

## 2026-05-13 - template install depends on the first scoped npm publish

The template correctly imports `@domecs/core`, `@domecs/dom`, and
`@domecs/input`, but those packages are not published to npm yet. A fresh
`npm install` in the standalone template currently fails with a registry 404
for `@domecs/core`.

Local verification used `DOMECS_LOCAL_DEV=1` Vite aliases pointed at the sibling
engine source and a local `tsconfig.local.json` pointed at built declaration
files. That keeps the template source honest against the public package names,
but it is not a substitute for the packed-package smoke test.

Suggested follow-up:

- Run this template through the same packed-tarball release validation path as
  the in-repository examples before publishing `create-domecs`.
- After the first npm publish, remove or stop relying on local verification
  aliases for normal template usage.
- Keep the template dependency declarations on the scoped public package names;
  do not switch the official template to `file:` dependencies.
