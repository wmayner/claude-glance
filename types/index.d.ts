export type Summary = { doing: string; why: string }

declare module 'claude-code' {
  interface PluginState {
    glance: { summary: Summary | null; isOff: boolean }
  }
}
