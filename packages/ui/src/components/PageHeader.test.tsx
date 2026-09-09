import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './PageHeader.js'

describe('PageHeader', () => {
  it('renders the title as the page h1', () => {
    render(<PageHeader title="Segments" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Segments' })).toBeInTheDocument()
  })

  // The whole point of extracting this: nineteen screens had settled on three
  // different sizes. One default, stated once.
  it('gives every title the same size by default', () => {
    render(<PageHeader title="Segments" />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveClass('text-xl')
    expect(heading).toHaveClass('font-semibold')
    expect(heading).toHaveClass('tracking-tight')
  })

  // SharedDashboard is a public page with no sidebar, where a bigger title is
  // right. It opts out by passing a size rather than by keeping its own h1 --
  // which is what makes it the exception rather than a twentieth variant.
  it('lets a screen override the size', () => {
    render(<PageHeader title="Growth overview" titleClassName="text-2xl" />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveClass('text-2xl')
    expect(heading).not.toHaveClass('text-xl')
  })

  it('renders no subtitle and no actions region when neither is given', () => {
    const { container } = render(<PageHeader title="Settings" />)
    expect(container.querySelectorAll('p')).toHaveLength(0)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a subtitle and actions when given', () => {
    render(
      <PageHeader
        title="Trends"
        subtitle="How many of an event over time."
        actions={<button type="button">Run</button>}
      />,
    )
    expect(screen.getByText('How many of an event over time.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
  })

  // An operator-supplied name (a segment's, a funnel's, a dashboard's) is
  // unbounded, and three screens already carry `min-w-0 break-words` by hand
  // for exactly that -- #218 is the issue where an over-long one pushed the
  // action buttons off the row. It is the default here so the fourth screen
  // cannot forget it.
  it('wraps a long title rather than letting it push the actions away', () => {
    render(<PageHeader title={'a'.repeat(200)} actions={<button type="button">Edit</button>} />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveClass('break-words')
    expect(heading).toHaveClass('min-w-0')
  })
})
