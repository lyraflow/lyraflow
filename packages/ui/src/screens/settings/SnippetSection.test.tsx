import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SnippetSection } from './SnippetSection.js'

// Small fix from the whole-branch review, previously shipped with zero
// regression tests (Task 8's own visual fixes -- min-h-dvh, the "1. Project
// created" label, and this wrapping class -- had none). `break-all` splits
// EVERY character regardless of whether a natural break point exists, so it
// split ordinary tokens mid-word, not only the write key -- `writeKey`
// could render as `wri`/`teKey`. `break-words` only forces a break inside a
// word when the word alone can't fit the line.
describe('SnippetSection', () => {
  it('wraps with break-words, not break-all, so ordinary tokens stay intact', async () => {
    render(<SnippetSection writeKey="wk_test123" />)
    const block = await screen.findByTestId('install-snippet')
    expect(block.className).toContain('break-words')
    expect(block.className).not.toContain('break-all')
  })
})
