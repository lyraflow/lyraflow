import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { Readiness, registerHealth } from './health.js'

function app(readiness: Readiness) {
  const f = Fastify()
  registerHealth(f, readiness)
  return f
}

describe('health endpoints', () => {
  it('reports healthy and ready once started', async () => {
    const r = new Readiness()
    r.markReady()
    const f = app(r)
    expect((await f.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await f.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200)
  })

  it('is not ready before startup completes', async () => {
    const f = app(new Readiness())
    expect((await f.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503)
  })

  it('stays healthy but stops being ready while draining', async () => {
    const r = new Readiness()
    r.markReady()
    r.markDraining()
    const f = app(r)
    expect((await f.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await f.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503)
  })
})
