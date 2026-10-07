# glance

During a long turn it can be hard to tell what Claude is doing, and easy to
forget what you asked for in the first place. Glance is a Claude Code mod
that shows both in one line. Once a turn has run for 20 seconds, the spinner's
usual word is replaced with a summary of the current step and the reason for
it, followed as usual by the elapsed time and token count:

![The spinner during a turn: "Testing glance spinner on mats-dev for 20s · to verify time display and animati…", followed by "(49s · ↓ 1.1k tokens)"](assets/spinner.png)

In a narrow terminal the line is shortened so that it stays on one row and
the elapsed time still fits.

When the turn ends, the last summary stays above the prompt until you send
your next message, so you can see at a glance what produced the turn:

![Above the prompt after the turn: "Last turn: Testing glance spinner on mats-dev for 20s" and "Why: to verify time display and animation don't interfere with rendering"](assets/band.png)

The summaries are written by Claude Haiku.

## Requirements

Claude Code, in the terminal or the desktop app's Code tab. Glance is
written against Claude Code's mod API, which is in early access and can change
between releases. It was tested with Claude Code 2.1.292.

## Installation

```
claude plugin marketplace add wmayner/claude-glance
claude plugin install glance@glance
```

Or, at the prompt of a running session:

```
/plugin install glance --marketplace wmayner/claude-glance
```

Installed with `/plugin`, it starts working in that session right away.
Either way, it runs in every session you start afterwards.

## How it works

- A turn shorter than 20 seconds is left alone and costs nothing.
- In a longer turn, Glance asks Haiku for a new line at most once a minute,
  and only when Claude has called a tool since the last one.
- Haiku sees your current request, the request and reply before it (so that
  "yes, do that" still has its context), Claude's last few messages in the
  turn, and its last ten tool calls. It also sees the previous line, so the
  reason stays the same from one update to the next unless the goal changes.
- If a todo list is driving the spinner, the todo's text is kept and the
  reason is added after it.
- If a Haiku call fails, the previous line stays where it is and the reason
  for the failure is logged once in the transcript.

Only the main conversation is summarized. Subagents' own spinners are left
as they are.

## Cost and privacy

Each summary is one Haiku request of a few thousand input tokens, made with
the same account and provider as the rest of your session. The excerpts of
your conversation listed above are sent with each request; nothing is sent
anywhere else.

## Updating and uninstalling

```
claude plugin update glance@glance
claude plugin uninstall glance@glance
```

Restart Claude Code after an update, or run `/reload-plugins`.

## Development

Run a session with your working copy loaded:

```
claude --plugin-dir /path/to/claude-glance
```

Saving a file reloads the mod at the end of the current turn. To check the
manifest and run the tests:

```
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` registers the hooks, and `hooks/logic.ts` has the
timing rules, the text sent to Haiku and the formatting, so most changes only
touch the second file. Claude Code writes the API's type declarations into
`.claude-plugin/types/` the first time it loads the mod; after that,
`npx tsc -p .` type-checks it.

## License

MIT
