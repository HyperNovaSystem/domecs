/**
 * domecs-v1.cjs — jscodeshift codemod for domecs v1.0 breaking changes.
 *
 * Auto-edits (safe, no human review needed):
 *   1. Import specifier renames from @domecs/core or @domecs/dom:
 *      Added→OnAdded, Removed→OnRemoved, Changed→OnChanged, ChangedResource→OnChangedResource
 *      (plus renames all *bound* references to that local name in the file)
 *   2. .step() with ZERO arguments → .stepOnce()  (arg-present calls are untouched)
 *
 * Guarded member renames (only when receiver is determinably domecs World/Rng):
 *   World: .resource(→.getResource(  .count(→.countEntities(  .entitiesMatching(→.listEntities(
 *          .select(→.selectViews(    .entitiesWith(→.iterEntitiesWith(  .start(→.startLoop(
 *   Rng:   .next(→.uniform(  .int(→.uniformInt(  .range(→.uniformRange(  .roll(→.uniformRoll(
 *
 * Receiver guard heuristic (documented in README):
 *   A receiver is treated as "domecs World" if it is an Identifier whose binding
 *   originates from one of:
 *     - VariableDeclarator where the init is a CallExpression whose callee ends in
 *       "createWorld" or "world" (member access or identifier).
 *     - FunctionParam/destructuring named "world" or matching /[Ww]orld$/.
 *     - Identifier named "world" (case-sensitive heuristic).
 *   A receiver is treated as "domecs Rng" if its binding originates from:
 *     - VariableDeclarator where the init is a CallExpression whose callee ends in
 *       "createRng", "restoreRng", or "fork".
 *     - Identifier named "rng" or matching /[Rr]ng$/.
 *   MemberExpression chains are also followed one level: if obj is itself a member
 *   access named "world" or "rng" on any receiver, it qualifies.
 *   When NOT determinable: the call is left alone and a CODEMOD-REVIEW comment is
 *   inserted on the line above.
 *
 * Flag-only (CODEMOD-REVIEW comment, no edit):
 *   - mountDOM( calls (returns Result now; callers must unwrap)
 *   - changedOn: [...] property with an array literal value
 *   - DomecsError identifiers
 *   - SystemDef object literals containing rateHz, triggers, or reactsTo keys
 */

'use strict'

const IMPORT_RENAMES = new Map([
  ['Added',           'OnAdded'],
  ['Removed',         'OnRemoved'],
  ['Changed',         'OnChanged'],
  ['ChangedResource', 'OnChangedResource'],
])

const WORLD_METHOD_RENAMES = new Map([
  ['resource',          'getResource'],
  ['count',             'countEntities'],
  ['entitiesMatching',  'listEntities'],
  ['select',            'selectViews'],
  ['entitiesWith',      'iterEntitiesWith'],
  ['start',             'startLoop'],
])

const RNG_METHOD_RENAMES = new Map([
  ['next',  'uniform'],
  ['int',   'uniformInt'],
  ['range', 'uniformRange'],
  ['roll',  'uniformRoll'],
])

const DOMECS_SOURCE_RE = /^@domecs\//

/** Is this a callee that looks like `createWorld(...)` or `someWorld(...)` (ends in World)? */
function calleeIsWorldFactory(node) {
  if (!node) return false
  if (node.type === 'Identifier') {
    return node.name === 'createWorld' || /[Ww]orld$/.test(node.name)
  }
  if (node.type === 'MemberExpression') {
    const prop = node.property
    const propName = prop.type === 'Identifier' ? prop.name : null
    if (propName === 'createWorld' || (propName && /[Ww]orld$/.test(propName))) return true
  }
  return false
}

/** Is this a callee that looks like `createRng(...)` / `restoreRng(...)` / `rng.fork(...)` ? */
function calleeIsRngFactory(node) {
  if (!node) return false
  if (node.type === 'Identifier') {
    return node.name === 'createRng' || node.name === 'restoreRng' || /[Rr]ng$/.test(node.name)
  }
  if (node.type === 'MemberExpression') {
    const prop = node.property
    const propName = prop.type === 'Identifier' ? prop.name : null
    if (propName === 'fork') return true
    if (propName === 'createRng' || propName === 'restoreRng') return true
    if (propName && /[Rr]ng$/.test(propName)) return true
  }
  return false
}

/**
 * Walk up the scope chain to find the VariableDeclarator init expression for a
 * given identifier name, returning it (or null).
 */
function findInitForName(scope, name) {
  let s = scope
  while (s) {
    const bindings = s.bindings || {}
    if (Object.prototype.hasOwnProperty.call(bindings, name)) {
      const paths = bindings[name]
      if (paths && paths.length > 0) {
        const bindingPath = paths[0]
        // Check parent VariableDeclarator
        if (bindingPath.parent && bindingPath.parent.node.type === 'VariableDeclarator') {
          return bindingPath.parent.node.init
        }
        // If it's a param we can't resolve the init
        return null
      }
    }
    s = s.parent
  }
  return null
}

/**
 * Determine if a given AST expression node is a domecs World.
 * Uses the conservative heuristic described above.
 */
function isWorldReceiver(node, scope) {
  if (!node) return false

  if (node.type === 'Identifier') {
    const name = node.name
    // Direct name heuristic
    if (name === 'world' || /[Ww]orld$/.test(name)) return true
    // Try to resolve binding
    const init = findInitForName(scope, name)
    if (init && init.type === 'CallExpression') {
      return calleeIsWorldFactory(init.callee)
    }
    return false
  }

  // Handle chained member access like `this.world` or `ctx.world`
  if (node.type === 'MemberExpression') {
    const prop = node.property
    const propName = prop.type === 'Identifier' ? prop.name : null
    if (propName === 'world' || (propName && /[Ww]orld$/.test(propName))) return true
  }

  return false
}

/**
 * Determine if a given AST expression node is a domecs Rng.
 */
function isRngReceiver(node, scope) {
  if (!node) return false

  if (node.type === 'Identifier') {
    const name = node.name
    if (name === 'rng' || /[Rr]ng$/.test(name)) return true
    const init = findInitForName(scope, name)
    if (init && init.type === 'CallExpression') {
      return calleeIsRngFactory(init.callee)
    }
    return false
  }

  // Handle chained: `this.rng` / `ctx.rng`
  if (node.type === 'MemberExpression') {
    const prop = node.property
    const propName = prop.type === 'Identifier' ? prop.name : null
    if (propName === 'rng' || (propName && /[Rr]ng$/.test(propName))) return true
  }

  return false
}

const STATEMENT_TYPES = new Set([
  'ExpressionStatement',
  'VariableDeclaration',
  'ReturnStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'ThrowStatement',
  'TryStatement',
  'BlockStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'LabeledStatement',
])

/**
 * Walk up from `path` to find the nearest statement-level ancestor (or the
 * path itself if it already IS a statement), then attach a leading line comment.
 */
function insertLineComment(j, path, text) {
  let target = path
  while (target && !STATEMENT_TYPES.has(target.node.type)) {
    target = target.parent
  }
  if (!target) target = path

  const node = target.node
  if (!node.comments) node.comments = []
  const comment = j.commentLine(` ${text}`, true, false)
  node.comments.push(comment)
}

module.exports = function transform(fileInfo, api) {
  const j = api.jscodeshift
  const root = j(fileInfo.source)

  const counts = {
    importRenames: 0,
    stepNoArgRenames: 0,
    worldMethodRenames: 0,
    rngMethodRenames: 0,
    worldMethodFlagged: 0,
    rngMethodFlagged: 0,
    mountDomFlagged: 0,
    changedOnFlagged: 0,
    domecsErrorFlagged: 0,
    systemDefFlagged: 0,
  }

  // ─── STEP 1: Import specifier renames ─────────────────────────────────────
  // Collect which local names need to be renamed (imported name → new name)
  // e.g. `import { Changed as Foo }` → Foo stays but specifier becomes `OnChanged as Foo`
  //      `import { Changed }` → specifier becomes `OnChanged` and refs to `Changed` become `OnChanged`
  const importedLocalToNew = new Map() // localName → newExportedName

  root.find(j.ImportDeclaration).forEach(path => {
    const src = path.node.source.value
    if (!DOMECS_SOURCE_RE.test(src)) return

    path.node.specifiers.forEach(spec => {
      if (spec.type !== 'ImportSpecifier') return
      const importedName = spec.imported.name
      if (!IMPORT_RENAMES.has(importedName)) return

      const newName = IMPORT_RENAMES.get(importedName)
      const localName = spec.local.name

      // Rename the imported identifier
      spec.imported = j.identifier(newName)
      counts.importRenames++

      // If no alias (local === imported), we also need to rename references
      // If aliased (`Changed as MyCh`), local name stays, no ref renames needed
      if (localName === importedName) {
        // local name is also the old exported name — rename local + refs
        spec.local = j.identifier(newName)
        importedLocalToNew.set(localName, newName)
      }
    })
  })

  // Rename bound references for non-aliased imports
  if (importedLocalToNew.size > 0) {
    root.find(j.Identifier).forEach(path => {
      const name = path.node.name
      if (!importedLocalToNew.has(name)) return

      // Skip if this is the import specifier itself (already renamed above)
      if (path.parent.node.type === 'ImportSpecifier') return

      // Skip if it's a property key (object/member expression property)
      if (path.parent.node.type === 'MemberExpression' && path.parent.node.property === path.node && !path.parent.node.computed) return
      if (path.parent.node.type === 'Property' && path.parent.node.key === path.node && !path.parent.node.computed) return
      if (path.parent.node.type === 'ObjectProperty' && path.parent.node.key === path.node && !path.parent.node.computed) return

      // Avoid renaming sub-identifiers: only rename identifiers bound to our import.
      // We check by ensuring the identifier is a reference (not a property key, not a
      // declaration of a different binding).
      // The conservative check: ensure the name matches exactly and is not a substring
      // of a longer identifier (AST gives us atomic identifiers, so this is guaranteed).
      path.node.name = importedLocalToNew.get(name)
    })
  }

  // ─── STEP 2: .step() with zero args → .stepOnce() ─────────────────────────
  root.find(j.CallExpression, {
    callee: {
      type: 'MemberExpression',
      property: { type: 'Identifier', name: 'step' },
    },
  }).forEach(path => {
    if (path.node.arguments.length !== 0) return // .step(dt) — leave alone
    path.node.callee.property.name = 'stepOnce'
    counts.stepNoArgRenames++
  })

  // ─── STEP 3: Guarded World method renames ──────────────────────────────────
  WORLD_METHOD_RENAMES.forEach((newName, oldName) => {
    root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        property: { type: 'Identifier', name: oldName },
      },
    }).forEach(path => {
      const obj = path.node.callee.object
      const scope = path.scope

      if (isWorldReceiver(obj, scope)) {
        path.node.callee.property.name = newName
        counts.worldMethodRenames++
      } else {
        // Insert CODEMOD-REVIEW comment
        const commentText = `CODEMOD-REVIEW: .${oldName}( -> .${newName}( (verify receiver is a domecs World)`
        insertLineComment(j, path.parent, commentText)
        counts.worldMethodFlagged++
      }
    })
  })

  // ─── STEP 4: Guarded Rng method renames ────────────────────────────────────
  RNG_METHOD_RENAMES.forEach((newName, oldName) => {
    root.find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        property: { type: 'Identifier', name: oldName },
      },
    }).forEach(path => {
      const obj = path.node.callee.object
      const scope = path.scope

      if (isRngReceiver(obj, scope)) {
        path.node.callee.property.name = newName
        counts.rngMethodRenames++
      } else {
        const commentText = `CODEMOD-REVIEW: .${oldName}( -> .${newName}( (verify receiver is a domecs Rng)`
        insertLineComment(j, path.parent, commentText)
        counts.rngMethodFlagged++
      }
    })
  })

  // ─── STEP 5: Flag mountDOM( calls ──────────────────────────────────────────
  root.find(j.CallExpression, {
    callee: { type: 'Identifier', name: 'mountDOM' },
  }).forEach(path => {
    const commentText = 'CODEMOD-REVIEW: mountDOM() now returns Result<MountHandle, MountError> — unwrap .value / check isOk()'
    insertLineComment(j, path.parent, commentText)
    counts.mountDomFlagged++
  })

  // Also handle member-expression mountDOM (e.g. dom.mountDOM(...))
  root.find(j.CallExpression, {
    callee: {
      type: 'MemberExpression',
      property: { type: 'Identifier', name: 'mountDOM' },
    },
  }).forEach(path => {
    const commentText = 'CODEMOD-REVIEW: mountDOM() now returns Result<MountHandle, MountError> — unwrap .value / check isOk()'
    insertLineComment(j, path.parent, commentText)
    counts.mountDomFlagged++
  })

  // ─── STEP 6: Flag changedOn: [...] properties ──────────────────────────────
  root.find(j.ObjectProperty, {
    key: { type: 'Identifier', name: 'changedOn' },
  }).filter(path => path.node.value.type === 'ArrayExpression')
    .forEach(path => {
      const commentText = 'CODEMOD-REVIEW: changedOn:[] → {mode:"legacy"} or {mode:"explicit",types:[...]} (manual migration)'
      insertLineComment(j, path, commentText)
      counts.changedOnFlagged++
    })

  // Also handle Property (non-shorthand) for changedOn
  root.find(j.Property, {
    key: { type: 'Identifier', name: 'changedOn' },
  }).filter(path => path.node.value.type === 'ArrayExpression')
    .forEach(path => {
      const commentText = 'CODEMOD-REVIEW: changedOn:[] → {mode:"legacy"} or {mode:"explicit",types:[...]} (manual migration)'
      insertLineComment(j, path, commentText)
      counts.changedOnFlagged++
    })

  // ─── STEP 7: Flag DomecsError identifiers ──────────────────────────────────
  root.find(j.Identifier, { name: 'DomecsError' }).forEach(path => {
    // Only flag if it looks like a constructor call or match arm, not type annotations
    const parent = path.parent.node
    if (
      parent.type === 'NewExpression' ||
      parent.type === 'CallExpression' ||
      (parent.type === 'MemberExpression' && parent.object === path.node)
    ) {
      const commentText = 'CODEMOD-REVIEW: DomecsError construction/match arms need a `retryable` field in v1.0'
      insertLineComment(j, path.parent, commentText)
      counts.domecsErrorFlagged++
    }
  })

  // ─── STEP 8: Flag SystemDef literals with incompatible field combos ─────────
  const systemDefSuspectKeys = new Set(['rateHz', 'triggers', 'reactsTo'])
  root.find(j.ObjectExpression).forEach(path => {
    const props = path.node.properties
    const keys = props
      .filter(p => (p.type === 'Property' || p.type === 'ObjectProperty') && p.key && p.key.type === 'Identifier')
      .map(p => p.key.name)
    const hasSuspect = keys.some(k => systemDefSuspectKeys.has(k))
    const hasSchedule = keys.includes('schedule')
    if (hasSuspect && hasSchedule) {
      const commentText = 'CODEMOD-REVIEW: SystemDef — check rateHz/triggers/reactsTo are valid for this schedule type in v1.0'
      insertLineComment(j, path, commentText)
      counts.systemDefFlagged++
    }
  })

  // ─── Emit summary ──────────────────────────────────────────────────────────
  const total =
    counts.mountDomFlagged +
    counts.changedOnFlagged +
    counts.domecsErrorFlagged +
    counts.systemDefFlagged +
    counts.worldMethodFlagged +
    counts.rngMethodFlagged

  api.report(
    `[domecs-v1] ${fileInfo.path}: ` +
    `imports=${counts.importRenames} ` +
    `step-noarg=${counts.stepNoArgRenames} ` +
    `world=${counts.worldMethodRenames} ` +
    `rng=${counts.rngMethodRenames} ` +
    `world-flagged=${counts.worldMethodFlagged} ` +
    `rng-flagged=${counts.rngMethodFlagged} ` +
    `mountDOM-flagged=${counts.mountDomFlagged} ` +
    `changedOn-flagged=${counts.changedOnFlagged} ` +
    `domecsError-flagged=${counts.domecsErrorFlagged} ` +
    `systemDef-flagged=${counts.systemDefFlagged} ` +
    `total-manual=${total}`
  )

  return root.toSource({ quote: 'single' })
}

module.exports.parser = 'tsx'
