import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { Summary } from '../types'

export const MIN_MS = 20_000 // turns shorter than this get no summary unless asked with /glance
export const EVERY_MS = 60_000 // at most one refresh a minute
export const TICK_MS = 5_000

export type Turn = {
  request: string // what the user typed to start the turn, injected text removed
  running: boolean
  startedAt: number
  endedAt: number
  activity: number // bumped by each tool call; starts at 1 so a tool-less turn still gets a summary
  summarizedActivity: number
  summarizedAt: number
}

export const newTurn = (request: string, now: number): Turn => ({
  request,
  running: true,
  startedAt: now,
  endedAt: 0,
  activity: 1,
  summarizedActivity: 0,
  summarizedAt: -Infinity,
})

export function isDue(t: Turn, now: number): boolean {
  if (!t.running) {
    // A turn that ran long but ended before its first summary still gets one, for the band.
    return t.endedAt - t.startedAt >= MIN_MS && t.summarizedActivity === 0
  }
  return (
    now - t.startedAt >= MIN_MS &&
    t.activity > t.summarizedActivity &&
    now - t.summarizedAt >= EVERY_MS
  )
}

export const SYSTEM = `You write a short status for someone who is supervising an AI coding agent but not following the details. From the excerpt of their session, say at a high level and in plain everyday language what the agent is working on and why.

- "doing": what it is working on, in at most 15 words. Describe the goal, not the individual commands or files.
- "why": the reason, tied to what the user asked for, in at most 15 words.
- Leave out jargon, file paths, IDs, tool names and internal names, unless the user used them.
- If the agent has finished, or is waiting for the user, say so.
- If a previous status is given, keep its "why" unless the goal has changed.

Reply with JSON only: {"doing": "...", "why": "..."}`

/** One line of at most `limit` characters, whitespace collapsed. */
export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** A user message without the text Claude Code adds to it: reminders and slash-command wrappers. */
export function stripInjected(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<((?:local-)?command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

const ARG_KEYS = ['description', 'prompt', 'command', 'file_path', 'pattern', 'url', 'query', 'skill']

function describeCall(use: ToolUseSummary): string {
  const hint = ARG_KEYS.map(k => use.input[k]).find((v): v is string => typeof v === 'string' && v !== '')
  const status = use.text === undefined ? ' (running)' : use.isError ? ' (failed)' : ''
  return `- ${use.tool}${hint ? `: ${clip(hint, 140)}` : ''}${status}`
}

/**
 * The excerpt Haiku summarizes: the request that started the turn, the user's
 * earlier requests, what the agent said recently and its latest tool calls.
 */
export function buildDigest(
  messages: readonly SessionMessage[],
  request: string,
  previous: Summary | null,
  isFinished: boolean,
): string {
  const asks = messages
    .filter(m => m.role === 'user' && !m.toolResults?.length)
    .map(m => stripInjected(m.text))
    .filter(text => text !== '')
  const current = request || asks.at(-1) || ''
  const earlier = asks.filter(text => text !== current).slice(-2)
  const assistant = messages.filter(m => m.role === 'assistant')
  const notes = assistant.map(m => m.text.trim()).filter(text => text !== '').slice(-4)
  const calls = assistant.flatMap(m => m.toolUses).slice(-15)

  const parts = [`## The user's current request\n${clip(current, 1500) || '(none)'}`]
  if (earlier.length) parts.push(`## Earlier requests, oldest first\n${earlier.map(a => `- ${clip(a, 500)}`).join('\n')}`)
  if (notes.length) parts.push(`## What the agent said recently, oldest first\n${notes.map(n => `- ${clip(n, 400)}`).join('\n')}`)
  if (calls.length) parts.push(`## Its latest actions, oldest first\n${calls.map(describeCall).join('\n')}`)
  if (isFinished) parts.push('The agent has finished this turn and is waiting for the user.')
  if (previous) parts.push(`## Previous status\nDoing: ${previous.doing}\nWhy: ${previous.why}`)
  return parts.join('\n\n')
}

/** The reply as `{ doing, why }`; a reply that is not JSON is read as the "doing" half. */
export function parseReply(text: string): Summary | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (json) {
    try {
      const { doing, why } = JSON.parse(json) as Record<string, unknown>
      if (typeof doing === 'string' && doing.trim() !== '') {
        return { doing: clip(doing, 160), why: typeof why === 'string' ? clip(why, 160) : '' }
      }
    } catch {
      // Not JSON after all; read it as plain text below.
    }
  }
  const plain = clip(text.trim().split('\n')[0] ?? '', 160)
  return plain === '' ? null : { doing: plain, why: '' }
}
