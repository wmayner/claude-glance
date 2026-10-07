export type Line = string | null

declare module 'claude-code' {
  interface PluginState {
    'turn-gist': { line: Line }
  }
}
