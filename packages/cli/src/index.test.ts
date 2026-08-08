import { describe, expect, it } from 'vitest'
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from './api/output.js'
import { type CommandContext, runVersion } from './index.js'

function makeCtx(isTty: boolean): { ctx: CommandContext; out: string[] } {
  const out: string[] = []
  return { ctx: { write: (s) => out.push(s), isTty }, out }
}

describe('runVersion', () => {
  it('reports both versions under --json', async () => {
    // An agent checks what it is talking to before trusting field names. The CLI
    // version moves with every release; the schema version moves only when a
    // documented JSON field changes shape or meaning, which is the one an agent
    // actually needs.
    const { ctx, out } = makeCtx(true)
    await runVersion(['--json'], ctx)
    expect(JSON.parse(out.join(''))).toEqual({
      version: CLI_VERSION,
      output_schema: OUTPUT_SCHEMA_VERSION,
    })
  })

  it('also reports both versions under --json when not at a terminal', async () => {
    const { ctx, out } = makeCtx(false)
    await runVersion(['--json'], ctx)
    expect(JSON.parse(out.join(''))).toEqual({
      version: CLI_VERSION,
      output_schema: OUTPUT_SCHEMA_VERSION,
    })
  })

  it('prints both in one human line at a terminal', async () => {
    const { ctx, out } = makeCtx(true)
    await runVersion([], ctx)
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text).toBe(`version: ${CLI_VERSION}  output_schema: ${OUTPUT_SCHEMA_VERSION}\n`)
  })

  it('an explicit --human wins even when not at a terminal', async () => {
    const { ctx, out } = makeCtx(false)
    await runVersion(['--human'], ctx)
    const text = out.join('')
    expect(text).toBe(`version: ${CLI_VERSION}  output_schema: ${OUTPUT_SCHEMA_VERSION}\n`)
  })
})
