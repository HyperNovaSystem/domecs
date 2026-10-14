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
    /** If true, calls preventDefault() on handled keydown events. Default: false. */
    readonly preventDefaultKeys?: boolean;
}
/**
 * The environment-independent default {@link InputPluginOptions}. The target
 * options (`keyTarget`/`pointerTarget`/`wheelTarget`) and `pollGamepads`
 * are derived from `document`/`navigator` at install time and so are not
 * representable as static constants; they are omitted here.
 */
/** O-59 (I6): the default {@link InputPluginOptions.textInputSelector}. */
export declare const TEXT_INPUT_SELECTOR: string;
export declare const DEFAULT_INPUT_OPTIONS: Readonly<{
    readonly clearOnBlur: true;
    readonly textInputSelector: string;
    readonly preventDefaultKeys: false;
}>;
export declare function createInputPlugin(options?: InputPluginOptions): Plugin;

// file: index.d.ts
export { createInputPlugin, DEFAULT_INPUT_OPTIONS, TEXT_INPUT_SELECTOR } from './collector.js';
export type { InputPluginOptions } from './collector.js';
