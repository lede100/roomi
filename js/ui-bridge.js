/**
 * Lightweight runtime callback registry linking UI modules (chat, widgets, settings, app)
 * without circular top-level execution order issues.
 */
export const ui = {};

export function registerUI(methods) {
  Object.assign(ui, methods);
}
