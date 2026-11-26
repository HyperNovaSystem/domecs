// file: build-id.d.ts
/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and `pnpm publish:npm`
 * stamps the plain version (`scripts/stamp-build-id.mjs`), so a published
 * build carries it. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export declare const BUILD_ID: string;

// file: collector.d.ts
import type { Plugin } from '@domecs/core';
export interface InputPluginOptions {
    /** Element receiving keyboard events. Default: document. */
    readonly keyTarget?: Document | HTMLElement;
    /**
     * Element receiving pointer events. Default: document. Coordinates are the
     * events' viewport `clientX`/`clientY`, not relative to this element
     * (SPEC §6); subtract its `getBoundingClientRect()` for local coordinates.
     */
    readonly pointerTarget?: Document | HTMLElement;
    /** Element receiving wheel events. Default: pointerTarget. */
    readonly wheelTarget?: Document | HTMLElement;
    /** Should held keys be cleared when the window loses focus? Default: true. */
    readonly clearOnBlur?: boolean;
    /**
     * CSS selector for focused elements that take typing, whose keys pass
     * through. Default {@link TEXT_INPUT_SELECTOR}: text-like `input`s (not
     * checkboxes, radios, ranges, buttons, colour or file pickers),
     * `textarea`, `select` and any `contenteditable` other than `"false"`.
     */
    readonly textInputSelector?: string;
    /** Whether to read gamepads via navigator.getGamepads(). Default: true in browsers that expose it. */
    readonly pollGamepads?: boolean;
    /**
     * Which captured keydowns get `preventDefault()` — to stop Space scrolling
     * the page, say (H-2). Default `false`: none.
     * - `true`: the game keys — letters, digits, arrows, Space, Enter;
     * - a list of `KeyboardEvent.code`s: those;
     * - a function: whatever it returns `true` for. It alone decides.
     *
     * For `true` and a list, a key is never prevented while Ctrl, Meta or Alt
     * is held (so Ctrl/Cmd+R, +F, +L, +1…9 keep working), nor when its target
     * is an interactive control ({@link InputPluginOptions.interactiveSelector}),
     * so a focused button or link is still activated by Space and Enter and a
     * slider moved by the arrows. The game sees those keys either way. Key
     * repeats are prevented like the first press. Keys typed into a text input
     * are never captured or prevented.
     */
    readonly preventDefaultKeys?: boolean | readonly string[] | ((e: KeyboardEvent) => boolean);
    /**
     * CSS selector for the controls whose keys `preventDefaultKeys` leaves to
     * the browser: the event target or an ancestor matches it. Default
     * {@link INTERACTIVE_SELECTOR}.
     */
    readonly interactiveSelector?: string;
}
/**
 * The environment-independent default {@link InputPluginOptions}. The target
 * options (`keyTarget`/`pointerTarget`/`wheelTarget`) and `pollGamepads`
 * are derived from `document`/`navigator` at install time and so are not
 * representable as static constants; they are omitted here.
 */
/** O-59 (I6): the default {@link InputPluginOptions.textInputSelector}. */
export declare const TEXT_INPUT_SELECTOR: string;
/**
 * H-2: the default {@link InputPluginOptions.interactiveSelector} — elements
 * that act on keys themselves: buttons, links, summaries, form controls,
 * editable content and the ARIA widget roles.
 */
export declare const INTERACTIVE_SELECTOR: string;
export declare const DEFAULT_INPUT_OPTIONS: Readonly<{
    readonly clearOnBlur: true;
    readonly textInputSelector: string;
    readonly preventDefaultKeys: false;
    readonly interactiveSelector: string;
}>;
export declare function createInputPlugin(options?: InputPluginOptions): Plugin;

// file: index.d.ts
export { createInputPlugin, DEFAULT_INPUT_OPTIONS, INTERACTIVE_SELECTOR, TEXT_INPUT_SELECTOR } from './collector.js';
export type { InputPluginOptions } from './collector.js';
export { BUILD_ID } from './build-id.js';
