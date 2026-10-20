import {
  validateEventPayload,
  type ComponentBag,
  type ComponentType,
  type EventType,
  type World,
} from '@domecs/core'
import type { AstNode } from './ast.js'
import { RuleEvalError, type CompiledExpression, type EvalEnv } from './evaluator.js'

/**
 * A deferred structural or command effect of a rule (2.3, §6.1). Effects
 * are queued for an entity only when its `when` held and all its actions
 * succeeded (O-68 atomicity), with every expression evaluated at queue time
 * (self is the queuing entity; it sees the entity's own staged writes, like
 * a later action). They are applied at the end of the rule's run, in queue
 * order (payload, then entity ascending, then effect index), so iteration
 * and membership stay stable within the run.
 *
 * - `emit`: emit the event named `emit` with `payload` (field → expression;
 *   absent: `{}`). The payload is validated with `validateEventPayload`
 *   when applied; an invalid one is a `rule_eval_failed` fault on the
 *   queuing entity and is not emitted. Delivered **next tick** (bus
 *   semantics), so a chained event rule runs then.
 * - `spawn`: spawn the prefab `spawn` (from the `prefabs` option, called
 *   per spawn; each entry value is plain-data cloned). `at` writes the
 *   `spatial` option's position fields (requires `spatial`); `set` writes
 *   `"Component.field"` → expression, after `at`; a component the prefab
 *   lacks is added with its defaults. Ids follow apply order.
 * - `despawn`: despawn self or other. Idempotent; later effects that target
 *   a despawned entity are skipped.
 * - `add`: add the component to `to` (default self) from its defaults plus
 *   `set` (field → expression; `"Component.field"` naming the same
 *   component is accepted too). When the entity already has it, only `set`
 *   is applied (marked changed when a value changed).
 * - `remove`: remove the component from `from` (default self); absent is a
 *   no-op.
 *
 * Targets: `'other'` is the event rule's `other` binding; when it gave no
 * entity, or the entity is dead by the time the effect applies, the effect
 * is skipped. A world-scope event rule (no `self`, empty `query`) has no
 * self to target.
 */
export type RuleEffectDef =
  | { readonly emit: string; readonly payload?: Readonly<Record<string, string>> }
  | {
      readonly spawn: string
      readonly at?: { readonly x: string; readonly y: string }
      readonly set?: Readonly<Record<string, string>>
    }
  | { readonly despawn: 'self' | 'other' }
  | { readonly add: string; readonly to?: 'self' | 'other'; readonly set?: Readonly<Record<string, string>> }
  | { readonly remove: string; readonly from?: 'self' | 'other' }

/** Where an effect error points (a member of `RuleDefPath`). */
export interface EffectPath {
  readonly effect: number
  readonly part: string
}

/** One expression of an effect: parsed at compile time, compiled once memoization is known. */
export interface EffectSlot {
  readonly ast: AstNode
  readonly path: EffectPath
  /** Must produce a number (`at.x`, `at.y`). */
  readonly numeric: boolean
  run: CompiledExpression
}

type Target = 'self' | 'other'

/** A compiled effect. */
export type EffectPlan =
  | { readonly kind: 'emit'; readonly name: string; readonly type: EventType<unknown>; readonly fields: ReadonlyArray<readonly [string, EffectSlot]> }
  | {
      readonly kind: 'spawn'
      readonly prefab: string
      readonly at: { readonly type: ComponentType<any>; readonly x: string; readonly y: string; readonly ex: EffectSlot; readonly ey: EffectSlot } | undefined
      readonly set: ReadonlyArray<{ readonly type: ComponentType<any>; readonly field: string; readonly slot: EffectSlot }>
    }
  | { readonly kind: 'despawn'; readonly target: Target }
  | { readonly kind: 'add'; readonly type: ComponentType<any>; readonly target: Target; readonly set: ReadonlyArray<readonly [string, EffectSlot]> }
  | { readonly kind: 'remove'; readonly type: ComponentType<any>; readonly target: Target }

/** What compileRule lends {@link compileEffects}. */
export interface EffectCompileContext {
  fail(path: EffectPath, position: number, message: string): void
  /** Resolve a component name (errors at position -1). */
  component(name: string, path: EffectPath, context: string): ComponentType<any> | undefined
  /** Report a forbidden field name; true when it is allowed. */
  field(name: string, path: EffectPath): boolean
  /** Parse and check one expression; undefined after reporting its errors. */
  expression(source: string, path: EffectPath, context: string): AstNode | undefined
  /** The spatial option's position component, or undefined after reporting why not. */
  spatial(path: EffectPath): { type: ComponentType<any>; x: string; y: string } | undefined
  readonly resolveEvent: ((name: string) => EventType<unknown> | undefined) | undefined
  readonly prefabs: ((name: string) => ComponentBag | undefined) | undefined
  /** World-scope event rule: no self. */
  readonly worldScope: boolean
  /** The rule binds `other`. */
  readonly hasOther: boolean
}

const KINDS = ['emit', 'spawn', 'despawn', 'add', 'remove'] as const
const KEYS: Readonly<Record<(typeof KINDS)[number], readonly string[]>> = {
  emit: ['emit', 'payload'],
  spawn: ['spawn', 'at', 'set'],
  despawn: ['despawn'],
  add: ['add', 'to', 'set'],
  remove: ['remove', 'from'],
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Check and parse `def.effects` (2.3, §6.1). Every error goes through
 * `ctx.fail` with `{ effect: i, part }`; `part` names the key (`'emit'`,
 * `'payload'`, `'spawn'`, `'at'`, `'despawn'`, `'add'`, `'to'`, `'remove'`,
 * `'from'`), the expression (`'payload.<field>'`, `'at.x'`, `'at.y'`,
 * `'set.<key>'`), or `'effect'` for the effect's shape; a non-array
 * `effects` is `{ effect: -1, part: 'effects' }`. Returns the plans and
 * every expression slot (their `run` is filled in by the caller).
 */
export function compileEffects(
  effects: unknown,
  ctx: EffectCompileContext,
): { plans: EffectPlan[]; slots: EffectSlot[] } {
  const plans: EffectPlan[] = []
  const slots: EffectSlot[] = []
  if (effects === undefined) return { plans, slots }
  if (!Array.isArray(effects)) {
    ctx.fail({ effect: -1, part: 'effects' }, -1, `"effects" must be an array of effects, got ${describe(effects)}`)
    return { plans, slots }
  }
  for (let i = 0; i < effects.length; i++) {
    const effect: unknown = effects[i]
    const at = (part: string): EffectPath => ({ effect: i, part })
    const kinds = isRecord(effect) ? KINDS.filter((k) => Object.hasOwn(effect, k)) : []
    if (!isRecord(effect) || kinds.length !== 1) {
      ctx.fail(at('effect'), -1, `An effect must have exactly one of ${KINDS.join(', ')}, got ${describe(effect)}`)
      continue
    }
    const kind = kinds[0]!
    let ok = true
    for (const key of Object.keys(effect)) {
      if (!KEYS[kind].includes(key)) {
        ctx.fail(at(key), -1, `Unknown key "${key}" in a ${kind} effect (expected ${KEYS[kind].join(', ')})`)
        ok = false
      }
    }
    const slot = (source: unknown, path: EffectPath, context: string, numeric = false): EffectSlot | undefined => {
      if (typeof source !== 'string') {
        ctx.fail(path, -1, `"${path.part}" must be an expression string, got ${describe(source)}`)
        return undefined
      }
      const ast = ctx.expression(source, path, context)
      if (!ast) return undefined
      const s: EffectSlot = { ast, path, numeric, run: undefined as unknown as CompiledExpression }
      slots.push(s)
      return s
    }
    const target = (value: unknown, part: string): Target | undefined => {
      const t = value ?? 'self'
      if (t !== 'self' && t !== 'other') {
        ctx.fail(at(part), -1, `"${part}" must be "self" or "other", got ${describe(value)}`)
        return undefined
      }
      if (t === 'self' && ctx.worldScope) {
        ctx.fail(at(part), -1, `A world-scope event rule (no "self", empty "query") has no self to ${kind}`)
        return undefined
      }
      if (t === 'other' && !ctx.hasOther) {
        ctx.fail(at(part), -1, '"other" needs an event rule with an "other" binding (e.g. other: "event.b")')
        return undefined
      }
      return t
    }
    const name = (part: string): string | undefined => {
      const v = effect[part]
      if (typeof v === 'string' && v.length > 0) return v
      ctx.fail(at(part), -1, `"${part}" must be a non-empty name, got ${describe(v)}`)
      return undefined
    }

    switch (kind) {
      case 'emit': {
        const eventName = name('emit')
        let type: EventType<unknown> | undefined
        if (eventName !== undefined) {
          type = ctx.resolveEvent?.(eventName)
          if (!type) {
            ctx.fail(at('emit'), -1, ctx.resolveEvent
              ? `Unknown event "${eventName}"`
              : `Unknown event "${eventName}" (no resolveEvent was given; installRules uses world.lookupEvent)`)
          }
        }
        const payload = effect['payload'] ?? {}
        const fields: Array<readonly [string, EffectSlot]> = []
        if (!isRecord(payload)) {
          ctx.fail(at('payload'), -1, `"payload" must be an object of field → expression, got ${describe(payload)}`)
          ok = false
        } else {
          for (const [field, source] of Object.entries(payload)) {
            const path = at(`payload.${field}`)
            if (!ctx.field(field, path)) {
              ok = false
              continue
            }
            if (type) {
              const problem = validateEventPayload(type, Object.fromEntries([[field, undefined]]))
              if (problem !== null) {
                ctx.fail(path, -1, `Event "${eventName}": ${problem}`)
                ok = false
                continue
              }
            }
            const s = slot(source, path, `referenced in emit "${eventName}" payload.${field}`)
            if (s) fields.push([field, s])
            else ok = false
          }
        }
        if (ok && eventName !== undefined && type) plans.push({ kind, name: eventName, type, fields })
        break
      }
      case 'spawn': {
        const prefab = name('spawn')
        if (prefab !== undefined) {
          if (!ctx.prefabs) {
            ctx.fail(at('spawn'), -1, `spawn "${prefab}" needs the prefabs option (installRules options.prefabs)`)
            ok = false
          } else if (ctx.prefabs(prefab) === undefined) {
            ctx.fail(at('spawn'), -1, `Unknown prefab "${prefab}"`)
            ok = false
          }
        } else ok = false
        let place: Extract<EffectPlan, { kind: 'spawn' }>['at']
        const atDef = effect['at']
        if (atDef !== undefined) {
          if (!isRecord(atDef) || typeof atDef['x'] !== 'string' || typeof atDef['y'] !== 'string' || Object.keys(atDef).length !== 2) {
            ctx.fail(at('at'), -1, `"at" must be { x, y } with expression strings, got ${describe(atDef)}`)
            ok = false
          } else {
            const spatial = ctx.spatial(at('at'))
            const ex = slot(atDef['x'], at('at.x'), `referenced in spawn "${prefab}" at.x`, true)
            const ey = slot(atDef['y'], at('at.y'), `referenced in spawn "${prefab}" at.y`, true)
            if (spatial && ex && ey) place = { ...spatial, ex, ey }
            else ok = false
          }
        }
        const set: Array<{ type: ComponentType<any>; field: string; slot: EffectSlot }> = []
        const setDef = effect['set'] ?? {}
        if (!isRecord(setDef)) {
          ctx.fail(at('set'), -1, `"set" must be an object of "Component.field" → expression, got ${describe(setDef)}`)
          ok = false
        } else {
          for (const [key, source] of Object.entries(setDef)) {
            const path = at(`set.${key}`)
            const dot = key.indexOf('.')
            if (dot <= 0 || dot === key.length - 1) {
              ctx.fail(path, -1, `spawn "set" keys must be "Component.field", got "${key}"`)
              ok = false
              continue
            }
            const field = key.slice(dot + 1)
            const fieldOk = ctx.field(field, path)
            const type = ctx.component(key.slice(0, dot), path, `referenced in spawn "${prefab}" set "${key}"`)
            const s = slot(source, path, `referenced in spawn "${prefab}" set "${key}"`)
            if (fieldOk && type && s) set.push({ type, field, slot: s })
            else ok = false
          }
        }
        if (ok && prefab !== undefined) plans.push({ kind, prefab, at: place, set })
        break
      }
      case 'despawn': {
        const t = effect['despawn'] === undefined ? undefined : target(effect['despawn'], 'despawn')
        if (effect['despawn'] === undefined) ctx.fail(at('despawn'), -1, '"despawn" must be "self" or "other"')
        if (ok && t) plans.push({ kind, target: t })
        break
      }
      case 'add': {
        const componentName = name('add')
        const type = componentName === undefined ? undefined : ctx.component(componentName, at('add'), 'referenced in add')
        const t = target(effect['to'], 'to')
        const set: Array<readonly [string, EffectSlot]> = []
        const setDef = effect['set'] ?? {}
        if (!isRecord(setDef)) {
          ctx.fail(at('set'), -1, `"set" must be an object of field → expression, got ${describe(setDef)}`)
          ok = false
        } else {
          for (const [key, source] of Object.entries(setDef)) {
            const path = at(`set.${key}`)
            const prefix = `${componentName}.`
            const field = key.startsWith(prefix) ? key.slice(prefix.length) : key
            if (field.length === 0 || field.includes('.')) {
              ctx.fail(path, -1, `add "${componentName}": set keys are ${componentName}'s field names (or ${componentName}.field), got "${key}"`)
              ok = false
              continue
            }
            const fieldOk = ctx.field(field, path)
            const s = slot(source, path, `referenced in add "${componentName}" set "${key}"`)
            if (fieldOk && s) set.push([field, s])
            else ok = false
          }
        }
        if (ok && type && t) plans.push({ kind, type, target: t, set })
        break
      }
      case 'remove': {
        const componentName = name('remove')
        const type = componentName === undefined ? undefined : ctx.component(componentName, at('remove'), 'referenced in remove')
        const t = target(effect['from'], 'from')
        if (ok && type && t) plans.push({ kind, type, target: t })
        break
      }
    }
  }
  return { plans, slots }
}

/** An effect queued for apply at the end of the run. */
export type QueuedEffect =
  | { readonly kind: 'emit'; readonly name: string; readonly type: EventType<unknown>; readonly payload: Record<string, unknown>; readonly source: number | undefined }
  | {
      readonly kind: 'spawn'
      readonly prefab: string
      readonly writes: ReadonlyArray<readonly [ComponentType<any>, string, unknown]>
      readonly source: number | undefined
    }
  | { readonly kind: 'despawn'; readonly target: number; readonly source: number | undefined }
  | { readonly kind: 'add'; readonly type: ComponentType<any>; readonly target: number; readonly writes: ReadonlyArray<readonly [string, unknown]>; readonly source: number | undefined }
  | { readonly kind: 'remove'; readonly type: ComponentType<any>; readonly target: number; readonly source: number | undefined }

/**
 * Evaluate `plans` for the entity `env.self` (undefined in world scope)
 * and append the results to `out`. Throws {@link RuleEvalError} like an
 * action; the caller then discards everything this entity queued.
 * Effects on an unbound `other` are not queued.
 */
export function queueEffects(plans: readonly EffectPlan[], env: EvalEnv, out: QueuedEffect[]): void {
  const source = env.self
  const targetOf = (t: Target): number | undefined => (t === 'self' ? env.self : env.other)
  for (const plan of plans) {
    switch (plan.kind) {
      case 'emit': {
        const payload: Record<string, unknown> = {}
        for (const [field, slot] of plan.fields) payload[field] = slot.run(env)
        out.push({ kind: 'emit', name: plan.name, type: plan.type, payload, source })
        break
      }
      case 'spawn': {
        const writes: Array<readonly [ComponentType<any>, string, unknown]> = []
        if (plan.at) {
          writes.push([plan.at.type, plan.at.x, position(plan.at.ex, env, 'at.x')])
          writes.push([plan.at.type, plan.at.y, position(plan.at.ey, env, 'at.y')])
        }
        for (const { type, field, slot } of plan.set) writes.push([type, field, slot.run(env)])
        out.push({ kind: 'spawn', prefab: plan.prefab, writes, source })
        break
      }
      case 'despawn': {
        const target = targetOf(plan.target)
        if (target !== undefined) out.push({ kind: 'despawn', target, source })
        break
      }
      case 'add': {
        const writes: Array<readonly [string, unknown]> = []
        for (const [field, slot] of plan.set) writes.push([field, slot.run(env)])
        const target = targetOf(plan.target)
        if (target !== undefined) out.push({ kind: 'add', type: plan.type, target, writes, source })
        break
      }
      case 'remove': {
        const target = targetOf(plan.target)
        if (target !== undefined) out.push({ kind: 'remove', type: plan.type, target, source })
        break
      }
    }
  }
}

function position(slot: EffectSlot, env: EvalEnv, part: string): number {
  const v = slot.run(env)
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RuleEvalError(`spawn ${part} must be a finite number, got ${describe(v)}`)
  }
  return v
}

/**
 * Apply `queue` in order (2.3, §6.1). A failure — an invalid emit payload,
 * a write a component cannot take, a prefab gone missing, a component
 * `validate` rejecting the result — skips that effect and is reported
 * through `fault(source, message)`; the other effects still apply. The
 * source may be dead by then (an earlier `despawn` in the queue); the
 * caller reports that case as a systemic fault.
 */
export function applyEffects(
  world: World,
  queue: readonly QueuedEffect[],
  prefabs: ((name: string) => ComponentBag | undefined) | undefined,
  fault: (source: number | undefined, message: string) => void,
): void {
  for (const effect of queue) {
    switch (effect.kind) {
      case 'emit': {
        const problem = validateEventPayload(effect.type, effect.payload)
        if (problem !== null) fault(effect.source, `emit "${effect.name}": invalid payload: ${problem}`)
        else world.emit(effect.type, effect.payload)
        break
      }
      case 'spawn': {
        const what = `spawn "${effect.prefab}"`
        const bag = prefabs?.(effect.prefab)
        if (bag === undefined) {
          fault(effect.source, `${what}: unknown prefab`)
          break
        }
        // Plain-data clone of every entry value: spawn shallow-copies
        // (O-34), so a shared prefab bag would otherwise share nested data.
        const values = new Map<ComponentType<any>, Record<string, unknown>>()
        for (const [type, value] of bag as Iterable<readonly [ComponentType<any>, unknown]>) {
          values.set(type, (isRecord(value) ? clonePlain(value, new Map()) : {}) as Record<string, unknown>)
        }
        // Prefabs are fetched again at apply time: check every type before
        // spawning, or a name another type holds would throw from spawn
        // part-way and leave a bare entity.
        const conflict = registerProblem(world, [...values.keys(), ...effect.writes.map(([type]) => type)])
        if (conflict !== null) {
          fault(effect.source, `${what}: ${conflict}`)
          break
        }
        let problem: string | null = null
        for (const [type, field, value] of effect.writes) {
          let target = values.get(type)
          if (target === undefined) {
            target = {}
            values.set(type, target)
          }
          const holder = Object.hasOwn(target, field) ? target : (world.describeComponent(type).defaults ?? {})
          problem = writeProblem(type.name, holder, field, value)
          if (problem !== null) break
          target[field] = value
        }
        if (problem !== null) {
          fault(effect.source, `${what}: ${problem}`)
          break
        }
        const entries: Array<readonly [ComponentType<any>, unknown]> = []
        try {
          for (const [type, value] of values) entries.push([type, type.create(value)])
        } catch (e) {
          fault(effect.source, `${what}: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
        world.spawn(entries)
        break
      }
      case 'despawn':
        if (world.isAlive(effect.target)) world.despawn(effect.target)
        break
      case 'add': {
        if (!world.isAlive(effect.target)) break
        const what = `add "${effect.type.name}"`
        const conflict = registerProblem(world, [effect.type])
        if (conflict !== null) {
          fault(effect.source, `${what}: ${conflict}`)
          break
        }
        const current = world.getComponent(effect.target, effect.type) as Record<string, unknown> | undefined
        if (current !== undefined) {
          // Already there: only `set` applies, checked as a whole first.
          let problem: string | null = null
          for (const [field, value] of effect.writes) {
            problem = writeProblem(effect.type.name, current, field, value)
            if (problem !== null) break
          }
          if (problem !== null) {
            fault(effect.source, `${what}: ${problem}`)
            break
          }
          let changed = false
          for (const [field, value] of effect.writes) {
            if (Object.is(current[field], value)) continue
            current[field] = value
            changed = true
          }
          if (changed) world.markChanged(effect.target, effect.type)
          break
        }
        const defaults = world.describeComponent(effect.type).defaults ?? {}
        const value: Record<string, unknown> = {}
        let problem: string | null = null
        for (const [field, v] of effect.writes) {
          problem = writeProblem(effect.type.name, Object.hasOwn(value, field) ? value : defaults, field, v)
          if (problem !== null) break
          value[field] = v
        }
        if (problem !== null) {
          fault(effect.source, `${what}: ${problem}`)
          break
        }
        let created: unknown
        try {
          created = effect.type.create(value)
        } catch (e) {
          fault(effect.source, `${what}: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
        world.addComponent(effect.target, effect.type, created)
        break
      }
      case 'remove':
        if (world.isAlive(effect.target) && world.has(effect.target, effect.type)) world.removeComponent(effect.target, effect.type)
        break
    }
  }
}

/**
 * O-67 for effect writes, as for actions: the field must exist (on the
 * value or the component's defaults) and keep its kind; a field holding
 * `null` or `undefined` takes any kind; numbers must be finite.
 */
function writeProblem(component: string, holder: Record<string, unknown>, field: string, value: unknown): string | null {
  const target = `${component}.${field}`
  if (!Object.hasOwn(holder, field)) return `cannot set ${target}: the component has no such field`
  const prior = holder[field]
  if (prior !== null && prior !== undefined && typeof value !== typeof prior) {
    return `cannot set ${target}: expected a ${typeof prior}, got ${typeof value}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return `cannot set ${target}: ${value} is not a finite number`
  return null
}

/**
 * Clone arrays and plain objects (null-prototype ones included)
 * recursively, cycles preserved; anything else is kept by reference
 * (component values are plain data by contract).
 */
function clonePlain(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  const known = seen.get(value)
  if (known !== undefined) return known
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(clonePlain(item, seen))
    return copy
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = proto === null ? Object.create(null) : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    const item = clonePlain((value as Record<string, unknown>)[key], seen)
    // An own `__proto__` key stays a key, never a prototype change.
    if (key === '__proto__') Object.defineProperty(copy, key, { value: item, writable: true, enumerable: true, configurable: true })
    else copy[key] = item
  }
  return copy
}

/** A short rendering of a def value for an error message (never throws). */
function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // fall through
  }
  return typeof value
}

/** Registers `types`; a reason when one is not a component type or its name is taken. */
function registerProblem(world: World, types: readonly ComponentType<any>[]): string | null {
  let registered
  try {
    registered = world.register(...types)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return registered.ok ? null : `another component type already holds the name "${registered.error.name}" in this world`
}
