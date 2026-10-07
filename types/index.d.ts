export type Line = string | null

declare module 'claude-code' {
  interface PluginState {
    'glance': { line: Line }
  }
}
