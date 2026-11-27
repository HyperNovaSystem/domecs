# Harbor Authority — findings surfaced against `@domecs/*`

Engine-side findings from rebuilding `../harbor_game` (exemplar #2) as a full
game on 2026-11-25, against this repo at `9ccde40` (`@domecs/*` 2.3.0). The app
now uses core, dom, persist, rules and inspector, runs entirely on the `fixed`
schedule, and is tested for determinism, restore, replay and branch
equivalence, so most of what follows comes from leaning on those paths.

App-side findings are in `../harbor_game/FINDINGS.md`. The cross-app ledger in
`plan/FINDINGS.md` draws from files like this one; ledger numbers (O-n) are
cited where an entry adds to one that is already open.

Every defect below was reproduced with a small test before it was written
down; the reproductions are quoted. Timings are from a 2-vCPU arm64 Linux
host, Node 26 (tests) and headless Chromium (browser).

**Status (2026-11-27):** every defect and gap in §1–§2 is fixed, and so
are P-1 to P-4 and the documentation drift: merged in #30 (`82b656c`) and
tagged `v3.0.0` (not yet on npm). Several fixes change behaviour, so it is
a major; `CHANGELOG.md` lists them under *Breaking*. [§0](#0-resolution)
says what each fix is, where it landed, and what was left out. Harbor's 144
tests pass on the fixed engine, and a deterministic 18,560-step career run
with the deputy hashes the same on the engine before and after. Moving
Harbor onto 3.0.0 turned up seven more, H-19 to H-25, which are open:
[§7](#7-adopting-300).

Contents:

0. [Resolution](#0-resolution) — what was done about each finding
1. [Defects](#1-defects) — seven behaviours that are wrong today
2. [Gaps](#2-gaps) — eleven things the app had to build or work around
3. [Proposals](#3-proposals) — larger changes, given that nothing depends on the engine yet
4. [Measurements](#4-measurements) — numbers for ledger items O-4, O-5, O-9, O-15, O-29
5. [Documentation drift](#5-documentation-drift)
6. [What held up](#6-what-held-up)
7. [Adopting 3.0.0](#7-adopting-300) — what Harbor now uses, and seven new findings (open)

At a glance:

| | Package | | What |
|---|---|---|---|
| H-1 | input | defect | a key tapped within one frame is dropped |
| H-2 | input | defect | `preventDefaultKeys` eats browser shortcuts and button activation |
| H-3 | core | defect | a fixed system's `ctx.time` is the frame's; no fixed-step clock |
| H-4 | core | defect | transient components' change marks are snapshotted (strict hash differs) |
| H-5 | core | defect | `bridge.act` says `accepted: true` for a command the handler refused |
| H-6 | core | defect | event schemas cannot require a field or reject NaN |
| H-16 | core | defect | `step(fixedStep)` × N runs N − 1 fixed steps (default 1/60 included) |
| H-7 | dom | gap | views cannot redraw on a resource; nothing for panels drawn from strings (lost clicks) |
| H-8 | dom | gap | no nested mounting; no way to get an entity's element |
| H-9 | dom, input | gap | no route from a DOM event to an entity |
| H-10 | dom | gap | change gate is world-wide; no ordered lists |
| H-11 | persist | gap | no codec hook in `save`/`load` |
| H-12 | persist | gap | no application save version; no slot header |
| H-13 | rules | gap | no `rateHz`; command-issuing rules need a latch |
| H-14 | core | gap | sub-rate fixed systems all fire on the same step |
| H-15 | core | gap | no "restored" signal |
| H-17 | core | gap | events leave the fixed phase once a frame: frame-rate dependence |
| H-18 | core | gap | `runBranch` hashes the world on every call |
| | | | *found adopting 3.0.0 (§7), open:* |
| H-19 | persist | gap | `save()` drops events not delivered yet: fixed events (H-17) in flight are lost |
| H-20 | core | gap | an `entity` field refuses a vanished id in the engine's words, not the app's |
| H-21 | dom | gap | `ViewDef.parent` names one parent view; a box that changes holders cannot follow |
| H-22 | dom | gap | `ViewDef.order` moves every node behind one that belongs first, dropping focus |
| H-23 | core | gap | `checkProbes: 'once'` still costs a strict hash per probe (0.19 s each on the hub) |
| H-24 | dom | gap | `definePanel` has no rate and cannot be asked to repaint |
| H-25 | core | defect | `world.action()` from a listener runs a tick inside the tick, losing the commands delivered with it |

Harbor works around all of them; none blocks the app. The three that shaped
its design most are H-3 (its own step clock), H-16 (a 16 Hz step) and H-17
(no events inside the simulation).

---

## 0. Resolution

Each finding was reproduced as a failing test first; the commits are on
`fix/harbor-findings`, off this file's branch.

| | Commit | What changed |
|---|---|---|
| H-16 | `d38bf30` | Fixed steps are counted off the time owed (a remainder below one step), not `floor(total / step)`: `step(fixedStep)` runs exactly one step and `step(n × fixedStep)` exactly n, at any step size, however long the world runs. Snapshots are v4 and carry `fixedTick`, `fixedAccumulator` and `fixedStep`; v3 ones restore as before. |
| H-3 | `d38bf30` | A fixed system's `ctx.time` is its step's clock: `delta = scaledDelta` = its step (× its divisor), `elapsed = fixedTick × fixedStep`, plus `fixedTick`. `world.time` gains `fixedTick` and `alpha`. Fixed rules take `dt` and `time` from it. |
| H-14 | `d38bf30` | `phase` on `rateHz` systems (and rules); SPEC §3 says a sub-rate system first runs after one period. Default 0 is unchanged; there is no automatic stagger, which would make run order depend on registration. |
| H-4 | `71903a3` | Snapshots drop marks on transient components, and carry a mark only while a system that watches that kind and component has not seen it. |
| H-18 | `ba59d76` | `runBranch` `finalHash: false` takes no hash (`finalHash` is then `null`); `checkProbes` defaults to `'once'` — each probe proven read-only the first time the world samples it (`true` keeps the 2.x check every call). |
| H-15 | `e9c90a1` | `world.signals.restored` after every successful restore, outside a tick, before the repaint; `createSpatialHash` refreshes on it. |
| H-6 | `e3bcf7d` | `FieldSchema.required`, `integer`, `kind: 'entity'` with `with: [...]`; non-finite numbers refused, `min`/`max` enforced, all before any tick; `describe()` shows them. `validateEventPayload(type, payload, { world, partial })`, `eventSchema(type)`. `step` stays a hint (`integer` says "integer"). |
| H-17 | `da6f6d0` | `{ schedule: 'event', fixed: true }`: an event system in the fixed loop; each step delivers what was emitted since the previous one, so step k's emits are handled in step k + 1 at any frame rate. Undelivered ones travel as `pendingFixedEvents`. Plain fixed systems keep reading the frame's view. |
| H-5, P-1 | `0759944` | `defineCommand(name, { schema, description, handle, fixed? })`, registered with `world.register`: `action()` / `bridge.act()` return the handler's `refuse(reason)` / `accept()` for that command. Throwing handlers refuse and fault; `describe()` marks commands; act logs record verdicts and replay stops with `verdict_mismatch`. Not done: an `action()` that applies without a tick. |
| H-1 | `2482730` | A tap inside one frame publishes both edges. |
| H-2 | `2482730` | `preventDefaultKeys` never prevents with Ctrl/Meta/Alt held or on an interactive control, also prevents repeats, and takes a list of codes or a function. |
| H-7 | `7dcfd82` | `changedOn.resources`; `definePanel` + `paint` / `watchPresses` (Harbor's helper, ported); `signals.resourceChanged` in core. A view of a resource alone (`defineView({ slot, resource })`) was not added: a panel covers it. |
| H-8 | `7dcfd82` | `ViewDef.parent: { view, of, at? }`, re-evaluated on update, children kept mounted out of the page while their parent has no element; `MountHandle.elementOf`. |
| H-9 | `7dcfd82` | `data-entity` on mounted elements, `entityOf(target)`, `MountHandle.on(slot, type, fn)`. |
| H-10 | `7dcfd82` | The redraw gate is `And(viewQuery, OnChanged(T))`; `ViewDef.order(entity)`. |
| H-11 | `cb89ba9` | Codecs (`SaveOptions.codec`, found by name on load), canonical JSON by default, `prepareSave` / `encodeSave` / `decodeSave`; `save()` returns `ok({ codec, length })` (O-29). |
| H-12 | `cb89ba9` | A header any save can be peeked by: a json save stays plain JSON with `meta` and `version` first, other codecs write a header line; `peek(storage, slot)`; `SaveOptions.appVersion`; `LoadOptions.accept(header)` returns `true`, `false` or a reason. Not done: a `'migrate'` answer — app migrations stay an `onRestore` plugin's job. |
| H-13 | `1e77c20` | `RuleDef.rateHz` / `phase`, and `fixed` for event rules. Not done: emit `once` / `cooldown`. With the handler in the next fixed step (a fixed event rule or fixed command, priority −100) a rule no longer re-emits while waiting, and `rateHz` paces retries; a deduplication by pending events would depend on the consuming phase, and a cooldown would keep rule state outside the snapshot. |
| P-2 | `cb89ba9` | `columnarCodec` in `@domecs/persist`, rather than a `SNAPSHOT_VERSION` 4 option: lossless, opt-in per save. |
| P-3 | `1cc3548` | `defineComponent.of<T>()(name, …)`, `defineResource.of<T>()`; the docs lead with the inferred no-type-argument form. |
| P-4 | `78bb837` | `world.setProfiling(true)` → `describe().systems[i].timing` and `describe().timing`; `createInspector({ profile: true })` and `timings()`; `MountHandle.stats()` per view and panel (O-5). |
| §5 | `5280884`, with the fixes | Every drift item: `Rng` names, `targetVersion`, SPEC §5.1, §5.5, §3, AGENTS.md rule 9, `doc/README.md`; `iterEntitiesWith` and `query().entities` state their cost. |

From §4, `maxSubsteps` (O-15) was not added: capping catch-up drops or
defers time, which is a policy for the app, not a fix.

The determinism golden was re-blessed (`632341e`) after checking that each
fixture's state and change marks hash the same on the engine before and
after; only the v4 clock fields differ.

---

## 1. Defects

### H-1 · `@domecs/input` drops a key that is pressed and released within one frame

`collector.ts` `onKeyUp` removes the pending press when the release arrives
before the next publish:

```ts
if (held.delete(code)) {
  releasedNext.add(code)
  pressedNext.delete(code)   // the tap is gone
}
```

So a tap shorter than a frame is reported as a release with no press, and
edge-triggered handlers never fire:

```ts
key('keydown', 'Space'); key('keyup', 'Space')   // between two ticks
world.stepOnce()
world.input.keyDelta.pressed    // []          ← expected ['Space']
world.input.keyDelta.released   // ['Space']
```

At 60 fps a frame is 16 ms and a human tap is 50 ms or more, so this hides
until the frame gets long — which is exactly when Harbor runs at 64× on a
large port (a 50 ms frame), when a tab is throttled, or under any automated
driver (Playwright's `keyboard.press` has no hold time: every hotkey failed).

**Impact:** Harbor's pause, speed and focus hotkeys were unreliable. The app
no longer uses `@domecs/input` at all; it reads `keydown` from the DOM.

**Suggested fix:** a tap inside one window should publish both edges — keep
the code in `pressedNext` and add it to `releasedNext`. `keys` (held) is
already right. This is the same class of loss as O-57 (heartbeat eating
edges), on the other side of the frame.

### H-2 · `preventDefaultKeys` blocks browser shortcuts and keyboard use of buttons

`isHandledKey` matches every letter, digit, arrow, Space and Enter, with no
regard for modifiers or for what has focus:

```ts
key('keydown', 'KeyR', { ctrlKey: true }).defaultPrevented   // true: Ctrl+R no longer reloads
button.focus(); press Enter on it  → defaultPrevented         // true: the button cannot be activated
```

With the option on, Ctrl/Cmd+R, +F, +L, +P, +1…9 stop working, and a keyboard
user cannot press a focused button or link with Space or Enter. The previous
Harbor shell had it on to stop Space scrolling the page.

**Suggested fix:** never prevent default while Ctrl, Meta or Alt is held, nor
when the event target is an interactive control (the plugin already has
`textInputSelector` for the text-entry half of this). Better, let the caller
say which keys are the app's: `preventDefaultKeys?: boolean | readonly string[]
| ((e: KeyboardEvent) => boolean)`.

### H-3 · A fixed system's `ctx.time` is the frame's, not the step's

When one frame runs several fixed sub-steps, each sees the same `tick`,
`elapsed`, `delta` and `scaledDelta` — the frame's values:

```ts
const w = createWorld({ headless: true, fixedStep: 1 / 15 })
w.system('f', { schedule: 'fixed' }, (ctx) => log(ctx.time.tick, ctx.time.elapsed, ctx.time.scaledDelta))
w.step(4 / 15)
// 1 0.267 0.267   1 0.267 0.267   1 0.267 0.267   1 0.267 0.267
```

SPEC §3's table says a `fixed` system sees the "integrated fixed delta". It
does not: a fixed system that integrates with `ctx.time.scaledDelta` — the
obvious thing to write, and what the quick-start does for `tick` systems —
moves `substeps ×` too far, and the error grows with the time scale. At 64×
that is 16× per frame. Nothing warns. The ledger records this for rules only
(O-69 R10, "documented, not changed"); `@domecs/rules` itself special-cases
it (`def.schedule === 'fixed' ? ctx.time.fixedStep : ctx.time.scaledDelta`).

There is also no step index: a fixed-step sim that wants deadlines ("crane is
done at step 6035") has nothing to count with. Harbor keeps its own `Clock`
component and increments it in a first-priority fixed system, which is the
single most load-bearing workaround in the app.

**Suggested fix:** inside a fixed system make `ctx.time` the fixed clock:
`delta = scaledDelta = fixedStep`, `elapsed` advancing by `fixedStep` per
sub-step, plus a monotonic `fixedTick` that the snapshot already implies
(`scaledTime / fixedStep`). Expose the interpolation remainder as a named
field too (`time.alpha = fixedAccumulator / fixedStep`): Harbor's views
compute exactly that every frame to draw 16 Hz state at 60 Hz.

### H-4 · Change marks of transient components are written into snapshots

`snapshot().changes` carries every mark some system has not seen. Marks on a
`transient: true` component are included, although the component itself is
not in the snapshot:

```ts
const T = defineComponent<{ k: number }>('TT', { defaults: { k: 0 }, transient: true })
// world a: a plugin's onRender adds and marks T on an entity; world b: identical, without it
// both: any system with a change filter that has not run yet, e.g. { schedule: 'fixed', rateHz: 1, query: OnChanged(T) }
a.snapshot().changes.marks   // [..., ['added','TT',0], ['changed','TT',0]]
hashSnapshot(a.snapshot())                              === hashSnapshot(b.snapshot())                              // true
hashSnapshot(a.snapshot(), { includeChanges: true })    === hashSnapshot(b.snapshot(), { includeChanges: true })    // false
```

So two worlds that differ only in presentation state (Harbor's `OnStage` and
`Listed` tags, written once per rendered frame) stop being strict-hash equal
as soon as any system reads changes. The 2.3 fix for transient *resources*
(O-36) excludes their marks for exactly this reason; components were missed.
Restore then re-issues marks for a component the restored world does not
hold.

Harbor is unaffected today only because none of its systems uses a change
filter; its branch-equals-live and replay tests would break the day one does.

A second, related observation from the same probe: the marks kept are *all*
marks newer than the slowest change-reading system's cursor, whatever
component they are on. A 1 Hz system watching `OnChanged(T)` pins every mark
made on every other component for up to a second, and all of them go into
each snapshot.

**Suggested fix:** drop marks whose component (or resource) is transient when
building `changes`, as for resources. Consider pruning per reader by the
components its filter can match.

### H-5 · `bridge.act` reports `accepted: true` for a command the world refused

A handler has no way to refuse. The verdict comes from `ActionOptions.resolve`,
supplied by the *caller* on each call, defaulting to accepted:

```ts
bridge.act('BuyCrane', { berth: 7 })   // berth 8 is not built; Harbor's handler refuses
// { accepted: true, events: [ Rejected { command: 'BuyCrane', reason: 'That berth is not open.' } ] }
```

Harbor's shell wraps `world.action` with a resolver that looks for its
`Rejected` event, so the UI gets `{ accepted: false, reason }`. An agent using
the bridge — the documented path — does not, unless it is told about the
app's private convention and passes the same resolver every time. For an
engine whose thesis is the operable simulation, "did my command work?" being
caller-defined is the wrong way round. Details and a proposal in
[P-1](#p-1--commands-as-a-first-class-thing).

### H-6 · `action()` accepts payloads the schema cannot describe as wrong

Schema validation is shallow and every declared field is optional:

```ts
const Cmd = defineEvent<{ crane: number }>('Cmd', { schema: { fields: { crane: { kind: 'number' } } } })
world.action(Cmd, {}).accepted                    // true — the one field it needs is missing
world.action(Cmd, { crane: NaN }).accepted        // true
world.action(Cmd, { crane: 1.5 }).accepted        // true — it is an entity id
```

`min`, `max` and `step` in `FieldSchema` are widget hints and are not checked.
Every one of Harbor's twenty handlers therefore re-validates its payload
(`isIndex`, "is this id a live crane?") before touching anything, and an
agent reading `describe()` cannot tell a required field from an optional one,
nor that a number names an entity. (The Studio security review left "payload
numbers" open; this is that, seen from an app.)

**Suggested fix:** `required?: boolean` on `FieldSchema`; reject non-finite
numbers; honour `min`/`max`, and `step: 1` as "integer"; add
`kind: 'entity'` with an optional `with: ComponentType` that `action()`
checks for liveness. That would delete most of Harbor's handler preambles.

### H-16 · Calling `step(fixedStep)` repeatedly skips a fixed step — at the default 1/60 too

SPEC §2.7 promises that a `fixed` system "fires exactly N times in N ×
fixedStep seconds of scaled time — at any `fixedStep`, ms-exact or not (e.g.
1/60)". It does not hold for any step that is not a binary fraction, because
the step count is `floor(totalScaledSeconds / fixedStep + 1e-9)` over a total
accumulated in floating point, and the accumulated error outgrows the 1e-9:

```ts
const w = createWorld({ headless: true, fixedStep: 1 / 60 })   // the default
let fired = 0
w.system('count', { schedule: 'fixed' }, () => { fired++ })
for (let i = 1; i <= 400_000; i++) w.step(1 / 60)
// fired === 399_999. The first tick that runs no fixed step is #22,785.
```

| `fixedStep` | 400,000 × `step(fixedStep)` | first tick with no fixed step |
|---|---|---|
| 1/60, 1/30, 1/15 | 399,999 steps | #22,785 |
| 1/20 | 399,999 steps | #13,146 |
| 1/16, 1/64 | 400,000 steps | never |

This is the accumulator that closed F-3 (commit `c255abc`, ~2% drift at
1/60 from millisecond rounding). It is right over the sixty steps that F-3's
regression test runs (`scheduler.test.ts`, "fires exactly N times per N
seconds at fixedStep=1/60"), and wrong from tick 22,785 on: a longer loop in
that test would have caught it.

At 60 Hz, tick 22,785 is six minutes in. The skipped step is made up on a
later tick (one tick runs two), so nothing is lost for good, but
`step(world.time.fixedStep)` — the idiom AGENTS.md and the API docs give for
headless fixed-schedule tests — does not mean "exactly one fixed step", and
two worlds stepped the same total time in different chunk sizes are, at any
given instant, up to one step apart. Harbor's first frame-rate-independence
test failed on exactly this, a day and a half of port time in.

**Impact:** Harbor's fixed step is 1/16 s rather than the exemplar's 1/15,
solely because 1/16 is exact in binary; with it, a frame of n steps runs n.

**Suggested fix:** count against a small remainder instead of a growing
total — `acc += dt; while (acc >= fixedStep × (1 − ε)) { acc −= fixedStep;
run }` keeps the error proportional to one step, not to the age of the
world — or keep the total in integer units (the snapshot's `scaledTime` would
then be exact as well; today it reads 0.9999999999999999 after fifteen
steps of 1/15).

---

## 2. Gaps

### H-7 · Views cannot watch a resource

`ViewDef.changedOn` takes component types only. Two consequences in Harbor:

- Port-wide state that the top bar shows (clock, cash, weather, reputation)
  lives on a singleton entity rather than in resources, because a resource
  could not drive a view. SPEC §2.11 calls resources "the canonical home for
  game-global state"; for anything that is drawn, they are not usable.
- The camera is a transient resource (`Focus`, the 2.3 recipe). Views whose
  look depends on it — which berth tile is focused, which ship row is
  selected — cannot be told it changed, so they run in `legacy` mode and
  redraw every frame.

**Suggested fix:** `changedOn: { mode: 'explicit', types: [...], resources:
[Focus] }`, redrawing every mounted node of the view when a listed resource
is marked. A view over no entity at all (`defineView({ slot, resource: R })`)
would let HUD read-outs be views of resources directly.

The rest of Harbor's interface — the tabbed side panel and the pipeline
strip — sums up many entities at once, so it is not a view at all: it is
rendered to a string a few times a second and written into the page. Doing
that with `innerHTML` went wrong in ways that only show with a hand on the
mouse. The button under the pointer was replaced between press and release,
so the click never fired: 3 of 12 human-speed clicks (120 ms press) were
lost at 64×. A focused button lost the focus on every repaint, so the panel
could not be worked from the keyboard while the clock ran. Harbor now patches
the DOM in place and holds off while a button is held down (`paint` and
`watchPresses` in `src/ui/dom.ts`, about 100 lines): 0 of 200 lost. Any app
that draws a panel from a string will hit this. `@domecs/dom` could ship that
helper, or a view of a derived value (`defineView({ slot, render: (world) =>
string })`) that patches rather than replaces.

### H-8 · Views mount flat; nothing can be mounted inside another entity's element

A view's element is appended to its slot. On Harbor's stage a container
belongs to something that moves — a deck, a crane's spreader, a carrier —
and should move with it. The box view therefore re-parents its own element
into the holder's element on every state change, which needs, by hand:

- a registry of holder elements (`Map<Entity, { deck, spreader, bed }>`),
  filled and emptied in other views' `create` and `destroy`;
- an "orphans" set retried each frame, for a box whose holder has no element
  yet (view order within one commit decides this);
- care at unmount: removing a ship's element takes its boxes' elements with
  it while the renderer still holds them as mounted.

It works and it is what makes the lift animation free, but it is a small
retained-mode renderer on top of the renderer. `@domecs/scene` has `Parent`;
`@domecs/dom` cannot use it.

**Suggested fix:** an optional `parent(entity): Entity | null` on `ViewDef`
(with a named mount point inside the parent's element), resolved at commit
after parents are created, and re-evaluated on change. Short of that,
`MountHandle.elementOf(view, entity)` would remove the registries: today the
handle exposes only `teardown`, so anything outside a view that needs an
entity's element (Harbor's selection outline, its tooltip) keeps its own map.

### H-9 · No route from a DOM event back to an entity

`PointerSnapshot.entered` is reserved and empty; pointer coordinates are raw
client coordinates. Harbor stamps `data-eid` on every element it creates and
runs one delegated listener per region (`closest('[data-eid]')`). Every
exemplar with clickable entities will write the same thirty lines.

**Suggested fix:** have `mountDOM` stamp mounted roots (`data-entity`) and
export `entityOf(el: Element): Entity | undefined`; optionally a delegated
`on(slot, 'click', (entity, event) => …)` on the mount handle.

### H-10 · Selective rendering is tag churn plus a port-wide change gate (adds to O-5)

Harbor draws ~300 of ~20,000 entities by adding and removing a transient
`OnStage` tag once per frame (a diff against the wanted set, so only what
moved is touched). That part is cheap. Two things are not obvious:

- The box view's redraw gate is `OnChanged(Container)` over *every*
  container in the world, not over the mounted ones. At 64× some hundreds of
  containers change hands per frame port-wide; all of them are collected and
  then discarded by the `mounted` lookup. It is a fraction of a millisecond
  here, but it scales with the world, not with the stage.
- Ordered lists have no support: nodes are appended in mount order. Harbor's
  roadstead (a queue, re-ranked every frame) sets CSS `order` from a `rank`
  field instead of moving nodes (O-6).

**Suggested fix:** intersect the change gate with the view's own query
before collecting (`And(viewQuery, OnChanged(T))` is expressible today — the
renderer could build that instead of a bare `OnChanged(T)`); an optional
`order(entity): number` on `ViewDef`.

### H-11 · `@domecs/persist` `save`/`load` cannot change the wire format

`save()` is `storage.write(slot, JSON.stringify(snapshot))`, and `load()` is
its inverse. A 21,000-entity Harbor port is 3.07 MB that way — over half of
localStorage's usual quota, so an autosave and one manual save do not fit.
Harbor packs single-component entities as tables (0.95 MB, same speed), which
meant not using `save`/`load` at all and re-implementing the envelope, the
`migrate` call and the restore error mapping around `Storage` (`saves.ts`).
`doc/api.md` itself notes that `save()` "still writes `JSON.stringify`
(follow-up)" where `canonicalJson` would be correct.

**Suggested fix:** `SaveOptions.encode?: (snap) => string` and
`LoadOptions.decode?: (text) => unknown`, or split the functions
(`serialize`/`saveText`, `parse`/`loadSnapshot`) so a host can put a codec —
or a worker — between the snapshot and the storage. `save()` returning
`ok({ bytes })` would close O-29 at the same time; Harbor's status bar gets
its figure from its own encoder.

### H-12 · Saves have no application version and no cheap header

Migrations are keyed by the engine's `SNAPSHOT_VERSION`. An app whose
component shapes change between releases (this rebuild changed all of
Harbor's) has nowhere to hang "saves from app format 1 are not loadable":
`load()` restores whatever name-keyed bags it finds, and component values are
not re-validated (by design, O-18). Harbor puts its format number in the
storage prefix so old saves are never seen, and again in its own envelope.

Separately, a save menu wants "Day 3 · 14:20 · $182,400" per slot. The only
way to learn anything about a slot is to parse all of it; Harbor writes a
sidecar slot (`<slot>.meta`) on every save instead.

**Suggested fix:** an app-supplied `appVersion` stamped into `meta` by
`save()`, with `LoadOptions.accept?: (meta) => boolean | 'migrate'` checked
before `restore`; and `peek(storage, slot): Result<meta | null>` backed by a
header the adapter can read without the body.

### H-13 · Rules have no rate, and a rule cannot issue a command cleanly

`SystemDef.rateHz` exists; `RuleDef` has no equivalent, so a `fixed` rule
polls on every step. Harbor's standing orders are rules ("an idle crane
below 45% is to be serviced"), and the first version did the obvious thing —
emit the `ServiceCrane` command as an effect:

```ts
when: 'Crane.state == "idle" && !Crane.ordered && Crane.condition < 0.45 && first(Orders).Orders.autoService',
actions: [{ set: 'Crane.ordered', expr: 'true' }],
effects: [{ emit: 'ServiceCrane', payload: { crane: 'self.id', auto: 'true' } }],
```

That needed two crutches: a latch on the entity (`ordered`), because the
command is handled next tick and the rule would otherwise emit it on every
sub-step until then, seventeen times a frame at 64×; and an `auto` flag on
the command, so a refusal was not reported to the player once per attempt.
It was then abandoned for the reason in H-17. The rules now only write a
field (`Crane.order = "service"`), and an ordinary fixed system later in the
same step acts on it with the code the command handlers use.

**Suggested fix:** `RuleDef.rateHz` (mapped to `SystemDef.rateHz`); and for
emit effects either `once: true` ("do not re-emit while this event for this
entity is still pending") or a `cooldown`.

### H-14 · Sub-rate fixed systems all fire on the same step

`rateHz` is a divisor of one shared counter, so every 1 Hz system runs on
steps 15, 30, 45…, together with every 5 Hz system:

```
1 Hz systems fired at steps 15,15,15,30,30,30 | 5 Hz at 3,6,9,…,15,…,30
```

Harbor has six 1 Hz and three 5 Hz systems. The mean step of the hub port
is 0.09 ms; the step on which they coincide is several times that, and at
64× it is inside every frame (worst frame 5–8 ms against a mean of 1.5 ms).
Also, a sub-rate system first runs after a full period, not on the first
step — worth a line in SPEC §3.

**Suggested fix:** `SystemDef.phase?: number` (run when `(counter + phase) %
divisor === 0`), or stagger sub-rate systems by registration index by
default. Deterministic either way.

### H-15 · No signal for "the world was just restored"

Plugin `onRestore` runs before the snapshot is applied (O-50), so there is no
hook from which derived state can be rebuilt once. The documented recipe is
"do it after `load()` returns", which assumes one call site; Harbor has
three (boot, the Load button, and tests restoring directly), plus whatever an
agent does through `bridge.reset()`. Harbor's answer was structural — keep
nothing outside the world, re-derive presentation tags every frame — which is
the right design anyway, but it is also the only one available: a cache that
is expensive to rebuild has no moment at which to be rebuilt.

**Suggested fix:** `world.signals.restored` (after apply, before the repaint
heartbeat). `createSpatialHash` and `@domecs/dom` could use it themselves.

### H-17 · Events cross the fixed phase once per frame, so using them makes a fixed-step sim frame-rate dependent

An event emitted during a fixed sub-step is delivered at the next *tick*, and
`event` systems run after the whole fixed phase. How many fixed steps pass
between an emit and its handling therefore depends on how many steps the
frame holds: none or one at 1×, seventeen at 64×, forty-eight on a slow
frame. Replay reproduces it (frames are recorded), but two live runs of the
same seed and the same commands at different frame rates diverge.

Harbor's standing orders, written as rules that emit a command (H-13),
showed it directly — same seed, same orders, stepped one step per tick
against fifteen:

```
Crane.until   7623 (one step per tick)   7650 (fifteen steps per tick)
```

The service started 27 steps later in the batched run, and everything
downstream differed from there. With the command replaced by a field write
plus a fixed system, `test/determinism.test.ts` holds the port's entities
bit-identical after forty port hours at one, sixteen and seventeen steps a
frame.

So today the rule for a frame-rate-independent fixed-step sim is: no events
between its own systems, and no rule `emit` effects that feed back into it.
That is a real restriction — events are the engine's decoupling tool, and
`@domecs/scene` contacts are delivered this way too (a `Contact` rule runs
up to a frame of fixed steps after the overlap).

**Suggested fix:** let an `event` system (and an event rule) opt into the
fixed phase — `{ schedule: 'event', phase: 'fixed' }` — so that an event
emitted in fixed sub-step k is delivered in sub-step k + 1. Events from
outside the tick (commands) would still enter at the frame's first sub-step.

### H-18 · `runBranch` costs a strict hash of the whole world on every call

`runBranch` always returns `finalHash`, and on the first sample of each call
hashes the world before and after every probe to prove the probes are
read-only. At 22,000 entities:

| | time |
|---|---|
| `createBranch` (setup + restore) | 79 ms |
| one step by `runBranch(world, { steps: 1 })` | 221 ms |
| the same with two probes | 729 ms |
| one step by `world.step(fixedStep)` | 0.11 ms |

The docs suggest calling `runBranch` again "to extend a branch", which is
what a host wants in order to spread a forecast over frames (or to cancel
it). At this size each such call costs a fifth of a second before it has
done anything. Harbor's outlook (`forecast.ts`) uses `createBranch` and then
steps the branch world by hand.

**Suggested fix:** `finalHash?: boolean` (default true) and
`checkProbes?: boolean | 'first-call'` on `RunBranchOptions`; or make
`finalHash` lazy (a getter). The purity check is valuable; once per branch is
enough.

---

## 3. Proposals

Larger than a fix; offered because nothing outside this workspace depends on
the current shapes yet.

### P-1 · Commands as a first-class thing

Today a command is an event with a schema, an `event` system that handles it,
and a caller-side resolver. Harbor has twenty and wrote the same scaffolding
around each: a system per event, a payload preamble (H-6), a `Rejected` event
to carry refusals out, a resolver to turn that back into a verdict (H-5), and
a counter. What the app means is:

```ts
defineCommand('BuyCrane', {
  description: 'Buy a Mk I crane for a berth that has room on its rails.',
  schema: { berth: { kind: 'number', integer: true, min: 0, required: true } },
  handle(ctx, { berth }) {
    if (cash < CRANE_COST) return refuse(`Not enough cash: $${CRANE_COST} needed.`)
    …
    return ok()
  },
})
```

with `world.action` / `bridge.act` returning the handler's verdict by
default, `describe()` listing commands apart from notifications, and replay
recording the verdict so a diverging refusal is caught at the act, not at the
next hash. Harbor's `commands.ts` is a 450-line worked example of what this
would replace.

Two smaller points from the same area:

- `action()` runs a tick, so it cannot be called from inside one. A hotkey
  read on `tickStart` has to `emit`, which has no verdict at all.
- In a real-time app each `action()` is an extra zero-`dt` tick: every tick
  system and a full DOM commit, per click. Correct, but worth saying in the
  docs; a command applied "now, without a tick" would be cheaper.

### P-2 · A columnar snapshot encoding

Harbor's packer (`saves.ts`, ~40 lines) groups entities that hold one
component of flat fields into `{ c, k, ids, v }` tables and leaves the rest
alone. On the hub port: 3.07 MB → 0.95 MB of JSON, no slower to write, and
lossless (`canonicalJson(unpack(pack(s))) === canonicalJson(s)`). Most of a
large world is that shape. As an engine-level `SNAPSHOT_VERSION` 4 option —
grouped by archetype, which the world already knows without scanning — it
would help every large exemplar, and it is a better starting point for the
chunked or off-thread snapshot of O-9 than a flat entity list.

### P-3 · A typed `defineComponent` that states the name once

`defineComponent<T, 'Name'>('Name')` repeats the name to keep it as a literal
type. Two things work today and neither is documented:

```ts
// 1. No type arguments: T and the literal name are both inferred from `defaults`.
const Ship = defineComponent('Ship', { defaults: { state: 'inbound' as ShipState, hold: [] as number[] } })
// 2. A curried helper (what Harbor uses, to keep explicit interfaces):
const component = <T>() => <const N extends string>(name: N, o?: ComponentOptions<T>) => defineComponent<T, N>(name, o)
const Ship = component<ShipData>()('Ship', { defaults: { … } })
```

`doc/api.md` presents the duplication as unavoidable. Shipping the curried
form (or documenting form 1 as the default) would make typed tuple queries —
which are excellent — the path of least resistance.

### P-4 · Per-system timings

`@domecs/inspector` records faults; nothing records cost. Harbor's status bar
times `tickStart`→`tickEnd` by hand, and finding out that one landing
animation (`getBoundingClientRect`) was half the frame took a CDP profile.
`describe().systems[i]` could carry `lastMs` / `meanMs` / `runs` when an
inspector is attached, and the renderer the same per view (O-5 asks for
mount/update counts).

---

## 4. Measurements

Hub scenario: 8 berths, 12 cranes, 500 workers, 40 warehouses, 200 ships,
~21,000 entities (the exemplar's mix). `test/budget.test.ts` in the app
re-measures these.

| What | Result | Ledger |
|---|---|---|
| One fixed step (16 Hz logical), mean | 0.09–0.11 ms | exemplar budget: 1 ms at 64× |
| One 64× frame (17 steps), mean / worst | 1.5–1.8 ms / 5–8 ms | H-14 explains the worst |
| Same frame in Chromium, with the DOM commit | 3–4 ms | O-5 |
| Step cost at 3,000 vs 22,000 entities | 0.08–0.13 ms either way | stored entities are free |
| `world.snapshot()` | 36 ms | O-9 |
| `JSON.stringify(snapshot)` | 17 ms, 3.07 MB | O-9, O-29, H-11 |
| Harbor save (snapshot + pack + stringify) | 80–97 ms, 0.95 MB | O-9 |
| `createBranch` from a snapshot | 79 ms | H-18 |
| One step through `runBranch` / with two probes | 221 ms / 729 ms | H-18 |
| `hashSnapshot(snap, { includeChanges: true })` | 180 ms | — |
| `load()` into a fresh world | 133 ms | O-9 |
| `markChanged` × 20,000 | 5–7 ms | O-4 |
| `getComponent` × 20,000 | 2–3 ms | — |
| `query.entities` over 20,000 (cached / rebuilt) | 1–2 ms | — |
| `iterEntitiesWith` over 20,000 | 8–10 ms | — |
| `spawn` + `despawn`, per pair | 5.7 µs | — |

Notes:

- **The step budget is met with room to spare**, but only because no system
  touches the containers. Deadlines are stored (`until`, `dropAt`), relations
  are stored on the owning side (a ship's `hold`, a berth's `yard`, a shed's
  `stock`), and a waiting entity is never read or marked. Anything written
  the natural way — "for each container, count down" — is 5 ms per step at
  this size from `markChanged` alone (O-4). The engine is fast enough; the
  pattern is what needs to be in the docs.
- **Autosave is a visible hitch at this size** (O-9): ~90 ms on the main
  thread, of which the engine's `snapshot()` is 36 ms and cannot be split or
  moved off-thread by the app. Harbor saves on a slow wall-clock timer and
  when the tab is hidden. At career size (hundreds of entities) it is 1 ms.
- **`iterEntitiesWith` is 4–5× slower than iterating a live query's
  `entities`** for the same set. The API docs present it as the convenient
  equivalent.
- **`query.entities` copies its array on every read** (`cachedViews.slice()`),
  and the cache is invalidated by any structural change anywhere in the world
  (one `structEpoch`). Harbor reads its small queries once per system run and
  keeps the array; a system that reads `.entities` in a loop pays each time.
- **Fixed catch-up is unbounded** (O-15): at 64× and the default 50 ms clamp
  a slow frame owes 48 steps. Harbor's steps are cheap enough that this never
  spirals, but there is no `maxSubsteps` to say so.
- **Forced layout is the thing to avoid in a view**: a FLIP animation that
  called `getBoundingClientRect` for every landed box was 48% of the frame at
  high speed. Harbor only does it at 1× and 4×.

---

## 5. Documentation drift

- **`doc/api.md` `Rng`** lists `next()`, `int()`, `range()`, `roll()`. The
  shipped interface is `uniform()`, `uniformInt()`, `uniformRange()`,
  `uniformRoll()` (`rng.ts`; the doctests in the same file use the real
  names). `plan/FINDINGS.md` "RNG helpers" has the old names too.
- **`doc/api.md` `@domecs/persist`** says `targetVersion` defaults to
  "`SNAPSHOT_VERSION`, 2" in two places; it is 3.
- **`doc/SPEC.md` §5.1** describes a `View<T>` with `target`,
  `create(entity, component)` and `update(el, entity, component, prev)`.
  `ViewDef` has none of `target`, the component argument or `prev`.
- **`doc/SPEC.md` §5.5** describes `virtualize: true`, a `shouldMount(entity,
  viewport)` hook and "a table-list view" that `@domecs/dom` "ships". None
  exists. This is the feature exemplar #2 is about, so it reads as if the
  app is doing it the hard way by choice.
- **`doc/SPEC.md` §3** says a `fixed` system sees the "integrated fixed
  delta" (see H-3).
- **`AGENTS.md` rule 9** ends "compare `JSON.stringify(snapshot())`"; the
  checklist further down the same file says not to, and why.
- **`doc/README.md`** calls `plan/FINDINGS.md` the "canonical and sole
  findings file — new findings land here", while per-app files like this one
  exist and every app's `CLAUDE.md` sends engine findings to
  `doc/FINDINGS_<app>.md` (and names the ledger as `../domecs/FINDINGS.md`,
  which moved to `plan/`).

---

## 6. What held up

Worth recording, because the app's design leans on each of these and none of
them gave trouble.

- **The fixed schedule is deterministic in the way that matters.** The same
  seed and commands give the same strict hash, and a save restored into a
  fresh world with a different seed continues bit for bit. Once H-16 and H-17
  were worked around, the port's entities are identical after forty hours at
  one, sixteen or seventeen steps a frame. The old Harbor's restore fault was
  the app's (ids captured in closures), and moving all state into components
  fixed it with no engine change.
- **`createBranch` / `runBranch`**: `installHarbor` is a `WorldSetup` as
  written, and a branch's `finalHash` equals the live world's after the same
  steps — with the live world carrying a stage plugin the branch does not
  have.
- **Reseeding a snapshot** (`{ ...snap, seed, rngRoot: seed, rngStreams:
  undefined }`) is all it takes to turn "the future" into "a possible
  future". Harbor's six-hour outlook is three reseeded branches; the test
  beside it shows that an un-reseeded branch is the live port's future to the
  cent.
- **`createRecorder` / `replay`**: a six-hour session with commands records
  with no gaps and replays to the same hash.
- **Own RNG streams** (`rng: 'own'`): the weather is provably the same
  whatever the player does, which is what makes "same seed, different
  decisions" a fair comparison.
- **Transient resources** for the camera: a load leaves the view where it
  was, with no re-seating (the old Harbor's second finding).
- **Plugin hooks render in install order**: installing the stage tagging
  before `mountDOM` is enough to make tags and DOM agree within one frame,
  including while paused.
- **`world.action` schema rejection** before any tick is spent, and
  `bridge.act` by name with `describe()` listing every command with its
  description: an agent can operate the port from the manifest alone (subject
  to H-5 and H-6).
- **`@domecs/rules`** compiled Harbor's two rules first time, cross-entity
  reads included, and `describe()` shows them as systems with their `meta`.
- **`restore()` validates before it wipes** (O-41): a save with a broken
  entity record is refused and the running port is untouched.
- **Typed tuple queries and views** (`world.query([Ship] as const)`,
  `e.Ship.hold`) removed nearly every `getComponent(...)!` from the hot loops.

---

## 7. Adopting 3.0.0

Harbor was moved onto 3.0.0 the same day (`../harbor_game`, branch
`feat/harbor-authority`, `1025460` to `0d4b3f7`, then the fixes from a
Codex review of that branch). What it uses now, in place of what it had
built:

- **Commands** (P-1, H-5, H-6): its twenty commands are `defineCommand`s,
  with schemas that say what the handlers used to re-check; `harbor.act` is
  plain `world.action`, and the `Rejected` report and the resolver reading
  it are gone.
- **The fixed clock** (H-3, H-16, H-14): the `Clock` component and the
  system that counted it are gone — `now()` is `START_STEP +
  world.time.fixedTick` — and the step is the exemplar's 1/15 s again. Its
  determinism test holds over 40 port hours (36,000 steps, past 2.x's tick
  22,785) at one, sixteen and seventeen steps a frame. The sub-rate systems
  each take a step of their own (`phase`); the stage interpolates with
  `time.alpha`.
- **Saves** (H-11, H-12, P-2): `save()` with `columnarCodec` (the hub: 950
  KB in 122 ms), the app's format as `appVersion`, the menu summary as
  `meta`; `peek()` reads it from the header line, and `accept` refuses
  another format with a reason. Harbor's own packer and its `.meta` sidecar
  slot are gone.
- **Rules** (H-13): the standing orders look once a port minute (`rateHz`,
  `phase`).
- **Branches** (H-18): the forecast extends its branches with `runBranch`
  (`finalHash: false`, `shouldStop` for the frame budget) instead of
  stepping them by hand.
- **DOM** (H-7, H-9, H-10, H-15): `paint` / `watchPresses` from
  `@domecs/dom`; `data-entity` and `entityOf` instead of Harbor's
  `data-eid`; the roadstead list kept in queue order by `ViewDef.order`;
  on `signals.restored` the shell drops milestone sheets still waiting and an
  outlook made of the port before the load.
- **`defineComponent.of`** (P-3) for its twenty components.

154 tests pass, and `npm run e2e` (35 checks in Chromium) passes on five
runs in a row. What it does not use, and why, is below, with H-25, which the
review found.

### H-19 · `save()` drops events that have not been delivered yet

```ts
// Step 1 emits Order; a fixed event system handles it in step 2 (H-17).
live.step(1 / 16)                      // emitted, not yet delivered
save(live, storage, 's')
load(twin, storage, 's')
live.step(1 / 16); twin.step(1 / 16)
// live handled it (n = 1); the twin never sees it (n = 0).
// A restore of snapshot({ pendingEvents: true }) keeps it.
```

`prepareSave` takes `world.snapshot()`, without pending events, and
`SaveOptions` cannot ask for them. Fixed event systems are meant for a
fixed-step simulation's own systems to talk through, but an event emitted
in step k waits for step k + 1 — at 1× that is a few frames, any of which
can be the one an autosave runs in — so a sim that uses them gives up exact
restores. Harbor's standing orders still write a component field for the
works system rather than emit an order, for this reason
(`src/sim/orders.ts`).

**Suggested fix:** `SaveOptions.pendingEvents`, passed to `world.snapshot`
— on by default, at least for undelivered fixed events, which are
simulation state. The load side already resolves them by name.

### H-20 · An `entity` field refuses a vanished id in the engine's words

`kind: 'entity'` always checks that the id is alive when a world is at
hand, and `world.action()` always passes one. A command whose target can
vanish between the click and the command — a ship that sails, a charter
offer that lapses, both ordinary at 64× — is refused with `field "ship" must
name a live entity; entity 312 is not alive`: a sentence for an agent, not
for the player who clicked. Harbor declares those ids `{ kind: 'number',
integer: true, min: 0 }` and keeps its own "That ship is not waiting for a
berth." in the handler; cranes and warehouses, which are never removed, are
entity fields with `with`.

**Suggested fix:** a field-level `refusal` text, used whichever check of
that field fails; or `kind: 'entity'` with `live: false`, which describes
the id (`describe()` still says it names a Ship) and leaves liveness to the
handler.

### H-21 · `ViewDef.parent` names one parent view

A Harbor container rides on a ship's deck (aboard), a crane's spreader
(lifted), the yard layer (in the yard) or a carrier's bed (hauled): three
entity views and a plain layer. `parent: { view, of, at }` nests a view's
elements in one other view's, so the box view would have to become one view
per holder kind, filtered by state, and a box changing hands would be
destroyed in one view and created in the next — a new element, and the
animation of it landing in the yard lost. Harbor keeps re-parenting the
box's element itself (`place` in `src/ui/stage.ts`).

**Suggested fix:** let `of` return the view with the entity —
`of: (e) => ({ view: ships, entity: e.Container.holder, at: '.deck' })`, or
`null` for the slot — so one view's elements can hang in different views'.

### H-22 · `ViewDef.order` moves every node behind one that belongs first

The reorder walks the sorted list and moves each node after the one before
it when it is not already there. A node that belongs ahead of the current
first one is left where it is, and every other node is moved after it:
mounting ten ranked rows, then one ranked first, takes ten `after()` calls
where one move would do (counted with a wrapped `Element.prototype.after`).
The order comes out right, but every move is a removal and an insertion,
which takes the focus from a control inside the moved row. Harbor's
roadstead (ships at anchor first, then those sailing in, each by arrival)
redraws every frame, so it reorders every frame, and the first ship to drop
anchor while the rest are still sailing in goes to the top: every other row
is moved behind it.

**Suggested fix:** move the fewest nodes (keep the longest run already in
order, move the rest), and use `Element.moveBefore` where the browser has
it, which keeps focus.

### H-23 · `checkProbes: 'once'` still costs a strict hash per probe

The proof hashes the world before the first probe and after each one: N + 1
strict hashes for N probes, on a branch's first sample. On the 22,000-entity
hub a strict hash is about 0.19 s; a one-step `runBranch` with two probes
takes 566–625 ms the first time and 1.4–1.8 ms after (Harbor's
`test/budget.test.ts`). The forecast has seven probes: about 1.5 s on the
first slice of each branch, three branches in a row. Harbor passes
`checkProbes: false` — its probes are plain reads.

**Suggested fix:** keep the per-probe proof as the default: it is what
makes the check exact. Two hashes around a whole sample would miss a probe
that changes a field which a later probe puts back, though the later probe
read the changed state (a Codex review of this file's first draft, which
proposed just that). What could be offered beside it is a weaker mode
that says so — `checkProbes: 'sample'`: one strict hash before a sample's
unproven probes and one after, going one by one only when the two differ,
to name the probe that changed the world. That is two hashes in place of
N + 1 (about 0.4 s on the hub instead of 1.5 s), for an app that accepts
the blind spot.

### H-24 · `definePanel` has no rate and cannot be asked to repaint

Harbor's side panel sums the whole port into a string. At 64× its inputs
change every frame, so a panel would be rendered at every commit; and it
depends on UI state no change gate sees (the open tab, a forecast being
worked out). So it stays outside `mountDOM`: a `tickEnd` subscriber renders
it every eighth frame, or at once on a tab change, and calls `paint`.

**Suggested fix:** a rate for panels (`everyFrames`, or a minimum interval)
and `MountHandle.invalidate(slot)` for a repaint the world did not cause.

### H-25 · `world.action()` from a listener runs a tick inside the tick

A `world.on` listener is called while the bus delivers a tick's events.
One that calls `world.action()` (Harbor's game-over sheet paused the port
with its `SetSpeed` command) starts a second tick inside the first. The
inner tick's flush replaces the outer tick's event view, and the verdict
the outer `action()` is waiting for, so a command delivered alongside the
report is never handled, and is refused for a reason that is not true:

```ts
world.on(Verdict, () => world.action(Pause, {}))   // accepted
world.emit(Verdict, { won: false })                // a report from the step before
world.action(Hire, {})
// { accepted: false, reason: 'command "Hire" was not handled: its handler
//   system command:Hire is disabled or removed' }
// Without the listener's action(), Hire is accepted.
```

`runSystems()`, `render()` and the recorder's calls throw when they are
called inside a tick; `action()`, `step()` and `stepOnce()` do not, and the
rule is written only in a comment in `world.ts` ("action() cannot run
inside a tick"). A Codex review of Harbor's branch found it; the shell now
pauses with `world.setScale(0)`, and its e2e sends a command in the tick
the game ends.

**Suggested fix:** refuse `action()` inside a tick, as `runSystems` does
(or answer `accepted: false`, `consumedTurn: false`, with a reason that
names the rule), with the same guard on `step` and `stepOnce`; and say so
in AGENTS.md, beside "Control while paused".

### Smaller

- Redrawing a view every frame — Harbor's clock and weather countdown,
  which follow `world.time.fixedTick` rather than a component — is
  `changedOn: { mode: 'legacy' }`. It is documented as "useful for
  time-driven animations", but the name says *deprecated*; `'always'`, with
  `'legacy'` kept as an alias, would say what it does.
