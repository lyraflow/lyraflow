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
  //    `request` does NOT send a normal browser User-Agent -- it is
  //    measurably `Playwright/<version> (<platform>) node/<version>`, which
  //    happens to match none of `BOT_TOKENS` (core/enrich/bots.ts), not
  //    because it resembles a browser's. That distinction matters here: a
  //    bare `curl` sends `curl/<version>`, which IS in the list, and would
  //    have the event dropped silently rather than accepted.
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

  // 5. The wizard notices on its own -- but per the CRITICAL fix, an
  //    arriving event only flips step 3 into its success state; it does
  //    NOT hand off to the dashboard by itself. The server key panel from
  //    step 2 must still be readable at this point, exactly as it was
  //    before the event arrived -- that is the whole point of the fix.
  await expect(page.getByText(/first event received/i)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('wizard-server-key')).toBeVisible()

  // 6. Only the operator's own click on "Continue to dashboard" leaves the
  //    wizard. The signal that the whole pipeline actually worked is the
  //    event showing up in the feed after that click.
  await page.getByRole('button', { name: /continue to dashboard/i }).click()
  await expect(page.getByText('page_view').first()).toBeVisible({ timeout: 30_000 })
})
