import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { buildDigest, isDue, newTurn, parseReply, stripInjected, SYSTEM, TICK_MS } from './logic'
import type { Turn } from './logic'
import type { Summary } from '../types'

const summary = atom({ plugin: 'glance', key: 'summary' } as const, null as Summary | null)
const isOff = atom({ plugin: 'glance', key: 'isOff' } as const, false)

export const register: Register = on => {
  // Module state is lost on a hot reload; the next turn.start rebuilds it.
  let turn: Turn | null = null
  let isBusy = false
  let isForced = false // /glance asked for a summary now

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'glance',
      description: 'Summarize what Claude is doing now; `off` hides the summaries, `on` shows them again',
    })
    const stored = (await $.store.get('isOff')) === true
    await update($, isOff, () => stored)

    $.clock.every(TICK_MS, async () => {
      if (turn === null || isBusy || (await read($, isOff))) return
      if (!isForced && !isDue(turn, await $.clock.now())) return
      const t = turn
      isBusy = true
      isForced = false
      // Count the attempt whether or not it succeeds, so a failing model is retried
      // at the normal pace and an ended turn is not retried at all.
      t.summarizedActivity = t.activity
      t.summarizedAt = await $.clock.now()
      try {
        const messages = await $.session.messages()
        if (!Array.isArray(messages)) return
        const reply = await $.model.complete({
          model: 'haiku',
          system: SYSTEM,
          prompt: buildDigest(messages, t.request, await read($, summary), !t.running),
          effort: 'low',
          maxTokens: 200,
          timeoutMs: 15_000,
        })
        if (!reply.isAnswered) throw new Error(reply.reason)
        const fresh = parseReply(reply.text)
        if (turn !== t || fresh === null) return // a new turn started while Haiku was answering
        await update($, summary, () => fresh)
      } catch (error) {
        $.ui.log(`glance: no summary (${error instanceof Error ? error.message : error})`, { to: 'debug' })
      } finally {
        isBusy = false
      }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A turn started without a typed prompt continues the work before it.
    if (e.text === '' && turn !== null) {
      turn.running = true
      return next(e)
    }
    turn = newTurn(stripInjected(e.text), await $.clock.now())
    await update($, summary, () => null)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (turn?.running) turn.activity += 1
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && turn !== null) {
      turn.running = false
      turn.endedAt = await $.clock.now()
    }
    return next(e)
  })

  on('command.run', { command: 'glance' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await $.store.set('isOff', arg === 'off')
      await update($, isOff, () => arg === 'off')
      return { text: arg === 'off' ? 'Glance is off. `/glance on` turns it back on.' : 'Glance is on.' }
    }
    if (await read($, isOff)) return { text: 'Glance is off. `/glance on` turns it back on.' }
    if (turn === null) return { text: 'Nothing to summarize yet.' }
    isForced = true
    return { text: 'Summarizing; the summary appears above the prompt in a few seconds.' }
  })

  // The band above the prompt, during the turn and after it. The spinner is left
  // to the engine: its own text after the word changes length (hook status,
  // effort), so a summary there would wrap the row on some frames.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isOff))) return next(e)
    const current = await read($, summary)
    if (current === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          <Text bold>{e.props.isWorking ? 'Now:' : 'Last turn:'}</Text> {current.doing}
        </Text>
        {current.why !== '' && (
          <Text dimColor wrap="truncate-end">
            <Text bold>Why:</Text> {current.why}
          </Text>
        )}
      </Box>
    )
  })
}
