import type { On, RenderPropsOf, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildDigest, isDue, newTurn, parseReply, stripInjected } from '../hooks/logic'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses,
})
const toolResult: SessionMessage = {
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: 'a', text: 'ok' } as never],
}

test('isDue waits 20s, then refreshes at most once a minute and only after new activity', () => {
  const t = newTurn('ask', 0)
  expect(isDue(t, 19_000)).toBe(false)
  expect(isDue(t, 20_000)).toBe(true) // turn start counts as activity
  t.summarizedActivity = t.activity
  t.summarizedAt = 20_000
  expect(isDue(t, 200_000)).toBe(false) // nothing new happened
  t.activity += 1
  expect(isDue(t, 70_000)).toBe(false)
  expect(isDue(t, 80_000)).toBe(true)
})

test('isDue gives a long turn that ended without a summary one last refresh', () => {
  const short = { ...newTurn('ask', 0), running: false, endedAt: 10_000 }
  const long = { ...newTurn('ask', 0), running: false, endedAt: 30_000 }
  expect(isDue(short, 30_000)).toBe(false)
  expect(isDue(long, 30_000)).toBe(true)
  expect(isDue({ ...long, summarizedActivity: 1 }, 30_000)).toBe(false)
})

test('stripInjected removes reminders and slash-command wrappers', () => {
  expect(stripInjected('fix the login <system-reminder>\nsecret\n</system-reminder>')).toBe('fix the login')
  expect(stripInjected('<command-name>/clear</command-name><local-command-stdout>ok</local-command-stdout>')).toBe('')
})

test('buildDigest leads with the turn request and drops injected text', () => {
  const digest = buildDigest(
    [
      user('first ask <system-reminder>secret</system-reminder>'),
      reply('Plan: do X then Y'),
      user('yes do it'),
      reply('Starting.', [
        { tool_use_id: 'a', tool: 'Bash', input: { command: 'make test', description: 'Run the tests' }, text: 'ok' },
        { tool_use_id: 'b', tool: 'Read', input: { file_path: 'a.ts' }, text: 'no such file', isError: true },
        { tool_use_id: 'c', tool: 'Edit', input: { file_path: 'b.ts' } },
      ]),
      toolResult,
      user('Stop hook feedback: summarize your last message'),
    ],
    'yes do it',
    { doing: 'Planning X', why: 'You asked for X' },
    true,
  )
  expect(digest.startsWith("## The user's current request\nyes do it")).toBe(true)
  expect(digest).toContain('- first ask')
  expect(digest).not.toContain('secret')
  expect(digest).toContain('- Plan: do X then Y')
  expect(digest).toContain('- Bash: Run the tests\n- Read: a.ts (failed)\n- Edit: b.ts (running)')
  expect(digest).toContain('The agent has finished this turn')
  expect(digest).toContain('Doing: Planning X\nWhy: You asked for X')
  expect(buildDigest([user('only <system-reminder>x</system-reminder>')], '', null, false)).toContain("request\nonly")
})

test('parseReply reads JSON, falls back to plain text, and rejects an empty reply', () => {
  expect(parseReply('Sure:\n{"doing": "Adding a login option", "why": "You asked for it"}')).toEqual({
    doing: 'Adding a login option',
    why: 'You asked for it',
  })
  expect(parseReply('{"doing": "Working"}')).toEqual({ doing: 'Working', why: '' })
  expect(parseReply('Adding a login option\nmore')).toEqual({ doing: 'Adding a login option', why: '' })
  expect(parseReply('  ')).toBe(null)
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 80 } as RenderPropsOf['AbovePrompt']
const DOING = 'Adding a remember-me option to the login page'
const WHY = 'You asked for logins to last between visits'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const bandText = async (band: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) =>
  (await band.findAll({ type: 'Text' })).map(t => t.text)

/** The engine beneath the plugin: a transcript, a model that counts its calls, and a band of its own. */
function stubEngine(on: On, answer: () => string | null) {
  const asks: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: '' }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [user('Make the login page remember me'), reply('On it.')] }))
  on('model.complete', ($, e) => {
    asks.push(e.prompt)
    const text = answer()
    return text === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const stored: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  return { asks, stored }
}

const JSON_REPLY = () => `{"doing": "${DOING}", "why": "${WHY}"}`

test('a long turn gets a summary in the band while it runs and after it ends', async ($, on) => {
  const clock = mock.clock(on)
  const { asks } = stubEngine(on, JSON_REPLY)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Make the login page remember me <system-reminder>x</system-reminder>', turnId: 't1' })

  await clock.advance(15_000)
  expect(asks).toHaveLength(0) // under 20s
  await clock.advance(5_000)
  expect(asks).toHaveLength(1)
  expect(asks[0]?.startsWith("## The user's current request\nMake the login page remember me\n")).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'glance', surface, component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
    expect(await bandText(band)).toEqual([`Now: ${DOING}`, 'Now:', `Why: ${WHY}`, 'Why:'])
    await band.unmount()
  }

  await clock.advance(60_000)
  expect(asks).toHaveLength(1) // no tool calls since, so no refresh

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(5_000)
  expect(asks).toHaveLength(2)

  await $.turn.complete({ answer: 'done', durationMs: 120_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const after = await $.ui.mount({ plugin: 'glance', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(after)).toEqual([`Last turn: ${DOING}`, 'Last turn:', `Why: ${WHY}`, 'Why:'])
  await after.unmount()

  await clock.advance(120_000)
  expect(asks).toHaveLength(2) // nothing after the turn ended

  await $.turn.start({ text: 'quick question', turnId: 't2' })
  const next = await $.ui.mount({ plugin: 'glance', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(next)).toEqual(['engine'])
})

test('a failing model is retried at the normal pace, and an ended turn is not retried', async ($, on) => {
  const clock = mock.clock(on)
  const { asks } = stubEngine(on, () => null)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'do it', turnId: 't1' })
  await clock.advance(20_000)
  expect(asks).toHaveLength(1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(30_000)
  expect(asks).toHaveLength(1) // not every 5s
  await clock.advance(30_000)
  expect(asks).toHaveLength(2)
  await $.turn.complete({ answer: '', durationMs: 80_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(120_000)
  expect(asks).toHaveLength(2)
})

test('a turn with no typed prompt continues the previous one and keeps its summary', async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, JSON_REPLY)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'do it', turnId: 't1' })
  await clock.advance(20_000)
  await $.turn.complete({ answer: '', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const band = await $.ui.mount({ plugin: 'glance', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toEqual([`Last turn: ${DOING}`, 'Last turn:', `Why: ${WHY}`, 'Why:'])
})

test('/glance summarizes a short turn on request, and /glance off hides it and stops model calls', async ($, on) => {
  const clock = mock.clock(on)
  const { asks, stored } = stubEngine(on, JSON_REPLY)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'glance', args: '', ...COMMAND })).text).toBe('Nothing to summarize yet.')

  await $.turn.start({ text: 'do it', turnId: 't1' })
  await $.command.run({ command: 'glance', args: '', ...COMMAND })
  await clock.advance(5_000)
  expect(asks).toHaveLength(1) // well under 20s, but asked for

  await $.command.run({ command: 'glance', args: 'off', ...COMMAND })
  const band = await $.ui.mount({ plugin: 'glance', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toEqual(['engine'])
  await band.unmount()
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(120_000)
  expect(asks).toHaveLength(1)
  expect(stored.isOff).toBe(true) // kept for later sessions

  await $.command.run({ command: 'glance', args: 'on', ...COMMAND })
  const back = await $.ui.mount({ plugin: 'glance', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(back)).toEqual([`Last turn: ${DOING}`, 'Last turn:', `Why: ${WHY}`, 'Why:'])
  await clock.advance(5_000)
  expect(asks).toHaveLength(2) // the tool call made while off still counts once it is back on
})
