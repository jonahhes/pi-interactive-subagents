/**
 * Shared mouse handling for the extension's click-to-toggle UI.
 *
 * pi's fullscreen TUI dispatches mouse input through the layout tree: on a
 * no-drag left-button release it synthesizes a `click` event and walks the
 * component boxes under the cursor (topmost first), dispatching until a
 * component returns `{ handled: true }` — which also makes the TUI request a
 * re-render. Components that never handle mouse events (e.g. plain `Text`)
 * fall through to text selection, which is exactly why un-wrapped expandable
 * content only responded to the global Ctrl+O / shortcut toggles.
 *
 * `claimLeftClick` is the shared half of that mechanism: the decision of
 * WHICH events claim the toggle, and the dispatch result that stops
 * propagation and re-renders. Each surface (the parent-side subagent message
 * renderers in index.ts, the subagent tools widget in subagent-done.ts)
 * invokes it from its own `handleMouse`, keeping its expansion state in its
 * own place (a per-message WeakMap / a closure variable).
 */
import {
  type Container,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

// Derived from the public Container API: the dispatcher-level result a
// component returns when it has consumed an event (handled + target bounds).
// Not re-exported by the pi-tui package root.
type TuiMouseDispatchResult = NonNullable<ReturnType<Container["handleMouse"]>>;

/**
 * If `event` is a plain left click, call `onToggle` and return the
 * `{ handled: true }` dispatch result. Any other event (right/middle click,
 * press, release, drag, move, wheel) returns `undefined`, so the dispatcher
 * keeps walking / falls back to selection handling — text selection and
 * right-click paste on the surface keep working exactly as on any other
 * rendered line.
 *
 * The plain result (no `target`) tells the 1.3.0 dispatcher that the calling
 * component consumed the event; it fills in `target` from the component's own
 * bounds. (A `target`-bearing result is only for containers forwarding to a
 * hosted child, which these toggle surfaces are not.)
 */
export function claimLeftClick(
  event: TuiMouseEvent,
  onToggle: () => void,
): TuiMouseDispatchResult | undefined {
  if (event?.type !== "click" || event?.button !== "left") return undefined;
  onToggle();
  return { handled: true } as TuiMouseDispatchResult;
}
