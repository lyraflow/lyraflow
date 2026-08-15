import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.js'

describe('App', () => {
  it('renders the shell around the placeholder content', () => {
    render(<App />)
    expect(screen.getByRole('link', { name: /feed/i })).toBeInTheDocument()
    expect(screen.getByText('The interface is being built.')).toBeInTheDocument()
  })
})
