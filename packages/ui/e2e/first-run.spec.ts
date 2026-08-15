import { expect, test } from '@playwright/test'

const EMAIL = process.env.LYRAFLOW_ADMIN_EMAIL ?? ''
const PASSWORD = process.env.LYRAFLOW_ADMIN_PASSWORD ?? ''

test('a fresh install goes from login to a first event', async ({ page, request }) => {
  test.skip(!EMAIL || !PASSWORD, 'admin credentials not provided')

  // 1. The login screen.
  await page.goto('/')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  // 2. No projects, so the wizard takes over.
  await page.getByLabel(/project name/i).fill('E2E App')
  await page.getByRole('button', { name: /create/i }).click()

  // 3. The snippet carries a real write key. Read it back out of the page
  //    rather than fetching it another way -- the point is that what the
  //    operator is shown is what actually works.
  const snippet = await page.getByTestId('install-snippet').innerText()
  const writeKey = snippet.match(/wk_[a-f0-9]+/)?.[0]
  expect(writeKey, 'the snippet must contain a write key').toBeTruthy()

  await expect(page.getByText(/waiting for your first event/i)).toBeVisible()

  // 4. Send a real event with that key, through the real ingest route.
  //    `request` (unlike a bare curl) sends a normal browser-ish
  //    User-Agent, which matters here: ingest classifies a bare `curl` as a
  //    bot and drops the event silently (`curl/` is in the bot-token list).
  const res = await request.post('/v1/track', {
    headers: { 'content-type': 'application/json', 'x-lyraflow-write-key': String(writeKey) },
    data: {
      message_id: crypto.randomUUID(),
      event: 'page_view',
      anonymous_id: 'e2e-1',
      context: { path: '/pricing' },
    },
  })
  expect(res.status()).toBe(202)

  // 5. The wizard notices on its own and hands off to the dashboard --
  //    there is no "I'm done" button on this path (only "Skip to
  //    dashboard", which means "I gave up waiting", the opposite of what
  //    this test is proving). The signal that the whole pipeline actually
  //    worked is the event showing up in the feed, unprompted.
  await expect(page.getByText('page_view').first()).toBeVisible({ timeout: 30_000 })
})
