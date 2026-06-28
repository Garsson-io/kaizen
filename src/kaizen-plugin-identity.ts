/**
 * kaizen-plugin-identity — single source of truth for how the kaizen plugin
 * identifies itself.
 *
 * The same two strings appear in many places: `enabledPlugins` keys, the
 * `installed_plugins.json` registry, `claude plugins install <source>`, the
 * plugin cache directory name, and the stream-json `system.init` event's
 * `plugins[]` entries (`{ name, source, path }`).
 *
 * Two mechanisms answer the question "is the kaizen plugin active?" — the
 * static on-disk checks in `kaizen-doctor` and the runtime init-event check in
 * `auto-dent-hook-activation`. They MUST agree on what the kaizen plugin *is*,
 * or one can pass while the other fails on a renamed plugin. Centralizing the
 * identity here is what keeps those two checks from drifting (#843).
 */

/**
 * The plugin's bare name — the `name` field in a `system.init` event's
 * `plugins[]` entry, and the prefix of the marketplace source string.
 */
export const KAIZEN_PLUGIN_NAME = 'kaizen';

/**
 * The marketplace install identifier (`<plugin>@<marketplace>`). This is the
 * key used in `enabledPlugins`, the `installed_plugins.json` registry, the
 * `claude plugins install` argument, and the `source` field of a `system.init`
 * `plugins[]` entry.
 */
export const KAIZEN_PLUGIN_SOURCE = 'kaizen@kaizen';
