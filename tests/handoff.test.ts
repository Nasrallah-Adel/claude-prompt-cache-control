// Run with: claude plugin test ~/.claude/skills/prompt-cache-control
import { describe, expect, test } from 'claude-code/testing'
import { parseRows, digestTranscript, fallbackBrief, wrapForNewSession, handoffPrompt, tailLines } from '../hooks/handoff.ts'

const user = (text: string, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra })
const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'huge output' }] } })

describe('parseRows', () => {
  test('skips blank and broken lines', () => {
    const rows = parseRows('{"type":"user"}\n\nnot json\n{"type":"assistant"}\n{"type":"us')
    expect(rows.map(r => r.type)).toEqual(['user', 'assistant'])
  })

  test('a long file is read from its tail, at a line boundary', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `{"type":"user","i":${i}}`)
    const text = lines.join('\n')
    const rows = parseRows(text, 100)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(50)
    expect((rows[rows.length - 1] as { i?: number }).i).toBe(49)
    expect(tailLines('abc', 100)).toBe('abc')
    expect(tailLines('abcdef', 3)).toBe('')
  })
})

describe('digestTranscript', () => {
  const rows = [
    { type: 'mode', mode: 'normal' },
    user('fix the login bug'),
    assistant([
      { type: 'text', text: 'Looking at auth.ts' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
    ]),
    toolResult(),
    assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    user('also update the docs'),
    user('ignored sidechain', { isSidechain: true }),
    user('ignored meta', { isMeta: true }),
    assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth.ts' } }]),
  ]

  test('keeps text and tool lines, drops tool results and side rows', () => {
    const d = digestTranscript(rows)
    expect(d.text).toBe(
      'user: fix the login bug\nassistant: Looking at auth.ts\nassistant used Read: src/auth.ts\nassistant used Bash: npm test\nuser: also update the docs\nassistant used Edit: src/auth.ts',
    )
    expect(d.text).not.toContain('huge output')
    expect(d.text).not.toContain('sidechain')
  })

  test('touched is de-duplicated, most recent last', () => {
    expect(digestTranscript(rows).touched).toEqual(['npm test', 'src/auth.ts'])
  })

  test('prompts are the last eight user texts', () => {
    const many = Array.from({ length: 12 }, (_, i) => user(`prompt ${i}`))
    expect(digestTranscript(many).prompts).toEqual(Array.from({ length: 8 }, (_, i) => `prompt ${i + 4}`))
  })

  test('a long conversation is cut from the start', () => {
    const d = digestTranscript([user('a'.repeat(100)), user('b'.repeat(100))], 120)
    expect(d.text.startsWith('…\n')).toBe(true)
    expect(d.text.endsWith('b'.repeat(100))).toBe(true)
    expect(d.text.length).toBe(122)
  })

  test('a long command is peeked, not copied', () => {
    const d = digestTranscript([assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(200) } }])])
    expect(d.touched[0]).toBe(`${'x'.repeat(80)}…`)
  })
})

describe('briefs', () => {
  const digest = digestTranscript([user('fix the login bug\nsecond line'), assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }])])

  test('handoffPrompt carries touched list and conversation', () => {
    const p = handoffPrompt(digest)
    expect(p).toContain('- a.ts')
    expect(p).toContain('user: fix the login bug')
  })

  test('fallbackBrief names the last prompts and the resume line', () => {
    const b = fallbackBrief(digest, 'sess-1')
    expect(b).toContain('- fix the login bug')
    expect(b).not.toContain('second line')
    expect(b).toContain('claude --resume sess-1')
  })

  test('wrapForNewSession frames the brief and asks for a one-line ack', () => {
    const w = wrapForNewSession('## Goal\n- ship', 'sess-1')
    expect(w.startsWith('Handoff brief from the previous session')).toBe(true)
    expect(w).toContain('claude --resume sess-1')
    expect(w).toContain('acknowledge in one line')
    expect(w.endsWith('## Goal\n- ship')).toBe(true)
  })
})
