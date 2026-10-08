// Pure helpers for the Clear button: turn a transcript into a digest a cheap
// model can brief from, and build the text the fresh session receives.
// No `$` calls here, so every function tests on its own.

export type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: { role?: string; content?: unknown }
}

export type Digest = {
  /** Turns in order, "user: ..." / "assistant: ...", trimmed to the cap from the start. */
  text: string
  /** Files and commands the tools touched, most recent last, de-duplicated. */
  touched: string[]
  /** The person's prompts, verbatim, oldest first. */
  prompts: string[]
}

export const DIGEST_CAP = 60_000
const PROMPT_KEEP = 8
const TOUCHED_KEEP = 20
const COMMAND_PEEK = 80

/** How much of a transcript's tail is parsed: a long session's file runs to many MB. */
export const TRANSCRIPT_TAIL_CHARS = 3_000_000

/** The last `cap` characters of a JSONL text, starting at a line boundary. */
export function tailLines(text: string, cap = TRANSCRIPT_TAIL_CHARS): string {
  if (text.length <= cap) return text
  const cut = text.slice(text.length - cap)
  const nl = cut.indexOf('\n')
  return nl === -1 ? '' : cut.slice(nl + 1)
}

/** Transcript lines (JSONL) -> rows; a line that is not JSON is skipped. Only the tail is read. */
export function parseRows(jsonl: string, cap = TRANSCRIPT_TAIL_CHARS): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const line of tailLines(jsonl, cap).split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as TranscriptRow)
    } catch {
      // a half-written last line, or a non-row: not ours to repair
    }
  }
  return rows
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

/** The conversation as text: user and assistant text blocks, tool calls as one line each. */
export function digestTranscript(rows: readonly TranscriptRow[], cap = DIGEST_CAP): Digest {
  const lines: string[] = []
  const prompts: string[] = []
  const touched: string[] = []
  for (const row of rows) {
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain || row.isMeta) continue
    const role = row.message?.role ?? row.type
    const content = row.message?.content
    if (typeof content === 'string') {
      if (role === 'user') prompts.push(content)
      lines.push(`${role}: ${content}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (block.type === 'text' && block.text) {
        if (role === 'user') prompts.push(block.text)
        lines.push(`${role}: ${block.text}`)
      } else if (block.type === 'tool_use') {
        const target = toolTarget(block)
        if (target) touched.push(target)
        lines.push(`assistant used ${block.name ?? 'a tool'}${target ? `: ${target}` : ''}`)
      }
      // tool_result bodies are left out: large, and the assistant's text already reflects them
    }
  }
  const joined = lines.join('\n')
  const text = joined.length > cap ? `…\n${joined.slice(joined.length - cap)}` : joined
  return {
    text,
    touched: dedupe(touched).slice(-TOUCHED_KEEP),
    prompts: prompts.slice(-PROMPT_KEEP),
  }
}

function toolTarget(block: Block): string | undefined {
  const input = block.input ?? {}
  const path = input.file_path ?? input.path ?? input.notebook_path
  if (typeof path === 'string') return path
  const command = input.command
  if (typeof command === 'string') return command.length > COMMAND_PEEK ? `${command.slice(0, COMMAND_PEEK)}…` : command
  return undefined
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...items].reverse()) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out.reverse()
}

export const HANDOFF_SYSTEM = `You write a handoff brief so a fresh Claude Code session can continue someone's work after the previous conversation was cleared.
Write in plain Markdown with exactly these headings, each followed by short bullets or one line; say "none" where there is nothing:
## Goal
## Current state
## Decisions made
## Files and commands touched
## Open items
## Next step
Be concrete: names of files, functions, flags, commands, errors. No preamble, no closing remarks, under 400 words.`

export function handoffPrompt(digest: Digest): string {
  const touched = digest.touched.length ? digest.touched.map(t => `- ${t}`).join('\n') : '- none recorded'
  return `Tools touched (most recent last):\n${touched}\n\nConversation (oldest first, truncated from the start if long):\n${digest.text}`
}

/** When the model gave no brief: the person's last prompts, verbatim, and how to go back. */
export function fallbackBrief(digest: Digest, previousSessionId: string): string {
  const prompts = digest.prompts.length ? digest.prompts.map(p => `- ${firstLine(p)}`).join('\n') : '- none recorded'
  const touched = digest.touched.length ? digest.touched.map(t => `- ${t}`).join('\n') : '- none recorded'
  return `## Goal\nNot summarised (the brief could not be generated). The last prompts were:\n${prompts}\n\n## Files and commands touched\n${touched}\n\n## Next step\nAsk me what to continue with, or run \`claude --resume ${previousSessionId}\` to reopen the full conversation.`
}

/** The text the fresh session is sent: the brief, framed so the first turn stays short. */
export function wrapForNewSession(brief: string, previousSessionId: string): string {
  return `Handoff brief from the previous session (cleared to reset the prompt cache; its id was ${previousSessionId}, reopen it with \`claude --resume ${previousSessionId}\` if you need the full history).\n\nRead it, then acknowledge in one line and wait for my next instruction. Do not start any work yet.\n\n${brief.trim()}`
}

function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}
