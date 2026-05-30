# DOMECS Findings — Iron Dynasty (railroad_game)

Notes from fleshing out `railroad_game`, a real-time, pausable railroad-tycoon
sim built per the four README pillars (economy + network + trains, tech tree,
politics & generations, legacy). The app deliberately exercises the full
optional surface: `@domecs/dom`, `@domecs/input`, `@domecs/inspector`, and
`@domecs/persist`.

## Summary

The core slice held up well for a management sim with an always-on game loop:
`fixed`/`tick`/`event`/`reactive`/`once` schedules, `setScale` for pause and
time multipliers, resources for the treasury singleton, `markChanged` for
reactive credit/tech recomputation, and errors-as-data (`Faulted`) for station
overload all composed cleanly. Determinism held across a save/load round-trip
(identical `snapshotHash`). 20/20 behavioral tests pass; the browser shell runs
the full loop (build line → buy train → resume → revenue + faults) end to end.

The friction was concentrated at the edges where the sim meets the browser:
persistence durability, paused-frame input, first-paint of entities spawned
while paused, and a TypeScript inference papercut in DOM views.

## Findings

### 1. `@domecs/persist` ships no browser-durable Storage adapter

`@domecs/persist` exports `save`/`load`/`createMemoryStorage`, but
`createMemoryStorage` is in-process only — it does not survive a reload, which
is the entire point of a Save button in a browser game. There is no
`createLocalStorageStorage` (or IndexedDB/File System Access) adapter, so the
app had to hand-roll one:

```ts
function createLocalStorage(prefix = 'iron-dynasty:'): Storage {
  return {
    read(slot) { try { return ok(localStorage.getItem(prefix + slot)) }
                 catch (cause) { return err({ kind: 'persist_io', op: 'read', cause: normalizeCause(cause) }) } },
    write(slot, data) { /* setItem + try/catch → Result */ },
    remove(slot)      { /* removeItem + try/catch → Result */ },
    list()            { /* scan Object.keys(localStorage) by prefix → Result */ },
  }
}
```

The `Storage` interface itself (4 methods, each returning `Result`, missing slot
= `ok(null)`) is clean and easy to implement. But every browser app will
re-implement this identically.

Suggestion:

- Ship `createLocalStorageStorage(prefix?)` (and ideally an async IndexedDB
  adapter) in `@domecs/persist`, or in a `@domecs/persist/web` entry to keep the
  core DOM-free.
- Document the prefix/`list()` scan pattern so hand-rolled adapters that *must*
  exist agree on slot enumeration semantics.

### 2. `defineComponent<T>('Name')` widens the name to `string` and breaks tuple-view field inference

Declaring a component with a single explicit type argument —
`defineComponent<CityState>('City', { ... })` — matches the overload
`defineComponent<T>(name: string): ComponentType<T, string>`, so the *name* type
parameter widens to `string`. Downstream, `ComponentTypeToField<ComponentType<T,
string>>` becomes an index signature `{ [P in string]: V }`. Under
`noUncheckedIndexedAccess` (which a strict app will have on), every tuple-view
field is then typed `T | undefined`:

```ts
const cityView = defineView({
  query: [City],
  update(el, e) {
    const c = e.City      // typed CityState | undefined, despite the query guaranteeing Has(City)
    // 'c' is possibly 'undefined' → 37 tsc errors across four views
  },
})
```

This produced ~37 `tsc` errors that are pure noise — the query statically
guarantees the component is present. Two workarounds exist, both unobvious:

- Pass the name as a second type arg so it stays a literal:
  `defineComponent<CityState, 'City'>('City', { ... })`.
- Or add an `if (!c) return` guard at the top of every `update()` (what the app
  did, to keep component declarations terse).

Suggestion:

- Make `defineComponent<T>('Name', …)` infer the name as a string *literal*
  (e.g. `defineComponent<T, const Name extends string>(name: Name, …)`), so a
  single explicit type arg doesn't silently widen.
- Or have `defineView`'s tuple-query form type its fields as non-optional from
  the query (the query is the proof of presence), independent of how the
  component name was declared.

### 3. Views with default `changedOn` never paint entities spawned before the first `markChanged`

`@domecs/dom` views with an omitted `changedOn` gate `update()` behind
`Changed(T)` for each `Has(T)` leaf. Entities that are spawned and then sit
untouched — e.g. the seven starting cities, created during the `once` founding
system while the world is paused at the title screen — are *mounted* but never
`update()`d, because nothing ever marks them `Changed`. Result: every city
rendered stacked at `(0,0)` with empty labels (its `style.left/top` and
`textContent` were never set) until some unrelated event happened to mark it.

The fix is one line per view but is easy to miss and hard to diagnose (the DOM
*looks* mounted):

```ts
const citiesView = defineView({ query: [City], changedOn: [], /* paint every frame */ create, update })
```

Suggestion:

- Run `update()` once on mount regardless of `changedOn` (initial paint), then
  gate subsequent runs as configured. A freshly-created node almost always needs
  its first `update()`.
- Failing that, document the "static entities need `changedOn: []`" trap
  prominently — it bites any app with content present before the first mutation.

### 4. `tick` systems are gated off while paused, so paused-frame input needs a `tickStart` subscription

Pausing via `world.setScale(0)` correctly freezes `fixed`/`tick` systems — the
sim stops. But that also means hotkeys read inside a `tick` system go dead while
paused, which is wrong for *control* input (Space to resume, S to save, B to
toggle build mode all must work while paused). `@domecs/input` does the right
thing — it calls `world.requestTick()` on keydown to pump one frame even when
idle/paused — but a `tick` system in that frame still won't run because of the
scale gate. The working pattern was to read input from the always-fires
`tickStart` signal instead:

```ts
world.signals.tickStart.subscribe(() => {
  const pressed = world.input.keyDelta.pressed
  if (pressed.has('Space')) setPaused(!paused)   // runs even at scale 0
  // …KeyS/KeyL/KeyB/Digit1-4/Equal/Minus
})
```

This works and is arguably correct (UI/control input is not simulation), but the
split — *sim* input belongs in a system, *control* input belongs in a signal
subscriber — is undocumented and easy to get wrong (everything silently works
until you pause).

Suggestion:

- Document the pause-gating boundary explicitly: which hooks fire at `scale 0`
  (`plugins.callTickStart`/`callRender`, `once`, `tickStart`/`tickEnd` signals)
  versus which don't (`tick`, `fixed`).
- Consider an opt-in "always run while paused" flag for systems that are purely
  UI/control (`world.system(id, { schedule: 'tick', runWhilePaused: true }, …)`),
  so control logic can live alongside sim logic without a separate signal path.

### 5. (minor) `save()` stamps wall-clock into blob meta — fine, but worth stating

`save()` writes `Date.now()` into the blob's meta. The round-trip is still
deterministic (the timestamp lives in meta, not in restored world state, so
`snapshotHash` matches after `load`), which is the right call — but it's only
discoverable by reading the source. A one-line guarantee in the docs ("save
meta carries wall-clock; restored world state does not, so hashes are stable
across save/load") would save the verification.

### 6. (minor) Nested `file:` workspace + Vite `fs.allow`

Installing the engine via `file:../domecs/packages/<pkg>` works, but Vite's dev
server needs `server.fs.allow: ['..']` to serve the sibling-directory sources,
and the optional packages resolve through the workspace's own `node_modules`.
This is standard Vite, not a DOMECS bug, but a one-paragraph "consuming DOMECS
from a sibling folder during development" note in the template would have saved a
round of `fs.allow` debugging.

## What worked well

- **Schedules covered every sim need.** `once` (founding), `fixed` (economy /
  trains / finance / politics stepping in scaled time), `reactive` (credit
  rating recompute on `Changed(Treasury)`, tech-mod recompute on
  `Changed(TechNode)`), `event` (commands), and `tick` (render) each landed
  naturally. The `fixed` accumulator under `setScale` gave free 0.5×/1×/2×/4×
  time control.
- **Errors-as-data fit the domain.** Station overload as a `Faulted` component
  (`kind: 'railroad/station-overloaded'`) flowed straight into the
  `@domecs/inspector` fault stream and onto a live HUD badge — no exceptions, no
  separate error channel.
- **`@domecs/inspector`** `onlyFaulted()` immutable snapshot views made a
  "service faults" panel trivial.
- **Determinism + persistence** round-tripped to an identical `snapshotHash`,
  including RNG-driven heirs/politics, across a seeded command stream.
- **Resources** modeled the singleton treasury/era/dynasty state without an
  awkward singleton entity.
- **Multi-slot `@domecs/dom`** (lines / stations / cities / trains as four
  stacked board layers) kept z-order and per-layer views clean.
