import { useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import type { Project, ProjectLimits } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { Skeleton } from '../../components/ui/skeleton.js'

const MIN_RETENTION_MONTHS = 1
const MAX_RETENTION_MONTHS = 120

/**
 * Parses the retention field. Returns a validation message instead of a
 * number when the input can't be sent -- the database CHECK is
 * `BETWEEN 1 AND 120`, and letting an out-of-range value reach Postgres
 * surfaces through the app's global error handler as a 503, which reads
 * as an outage for what is an ordinary client error. Caught here instead.
 */
function parseRetention(raw: string): { value: number } | { error: string } {
  const trimmed = raw.trim()
  const parsed = Number(trimmed)
  if (
    trimmed === '' ||
    !Number.isInteger(parsed) ||
    parsed < MIN_RETENTION_MONTHS ||
    parsed > MAX_RETENTION_MONTHS
  ) {
    return {
      error: `Retention must be a whole number of months between ${MIN_RETENTION_MONTHS} and ${MAX_RETENTION_MONTHS}.`,
    }
  }
  return { value: parsed }
}

/**
 * Parses the quota field. `monthly_event_quota` has three distinct states
 * and conflating any two of them breaks ingest:
 *
 * - An EMPTY input means "unlimited", which the API represents as `null`
 *   -- never `0` (`Number('')` is `0`, which is the trap) and never
 *   `NaN`.
 * - A typed value is sent as a number.
 * - `0` itself is refused by the API with a 400 -- `isOverQuota` throws
 *   on it rather than treating it as a limit, and a throw on that path
 *   becomes a 503 for every event of the project. Caught here so the
 *   person sees a client-side message instead of an opaque rejection.
 */
function parseQuota(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null }
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: 'Quota must be empty (for unlimited) or a whole number greater than zero.' }
  }
  return { value: parsed }
}

/**
 * Retention and quota, editable. The only section on this screen that
 * writes anything -- see `parseRetention`/`parseQuota` for the two traps
 * that make this the plan's sharpest task.
 *
 * Seeded from `project` (the active project's row from `useProject()`'s
 * `projects`, which already carries these fields) rather than a fetch of
 * its own. A rejected save leaves the typed value in place -- retyping a
 * value you just typed because the server said no is a small, avoidable
 * insult -- and a successful one is reported to `onSaved` so the caller
 * can update project context, keeping the header and any other section in
 * agreement with what was just changed.
 */
export function LimitsSection(props: {
  client: ApiClient
  project: Project | null
  onSaved: (patch: ProjectLimits) => void
}) {
  const { client, project, onSaved } = props

  const [retentionInput, setRetentionInput] = useState(() =>
    project ? String(project.retention_months) : '',
  )
  const [quotaInput, setQuotaInput] = useState(() =>
    project?.monthly_event_quota == null ? '' : String(project.monthly_event_quota),
  )
  const [retentionSaving, setRetentionSaving] = useState(false)
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [retentionError, setRetentionError] = useState<string | null>(null)
  const [quotaError, setQuotaError] = useState<string | null>(null)

  if (project == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Limits</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  // Rebound to a concretely-typed `const` -- TypeScript's narrowing of
  // `project` from the check above does not persist into the closures
  // below (they could, in principle, run after a reassignment); binding
  // to a new `const` with a fixed `Project` type sidesteps that instead
  // of a non-null assertion at every use.
  const activeProject: Project = project

  async function handleSaveRetention() {
    setRetentionError(null)
    const parsed = parseRetention(retentionInput)
    if ('error' in parsed) {
      setRetentionError(parsed.error)
      return
    }
    setRetentionSaving(true)
    try {
      const result = await client.patchProject(activeProject.id, { retention_months: parsed.value })
      onSaved(result)
    } catch {
      setRetentionError(
        'Could not save retention -- the value above was not changed on the server.',
      )
    } finally {
      setRetentionSaving(false)
    }
  }

  async function handleSaveQuota() {
    setQuotaError(null)
    const parsed = parseQuota(quotaInput)
    if ('error' in parsed) {
      setQuotaError(parsed.error)
      return
    }
    setQuotaSaving(true)
    try {
      const result = await client.patchProject(activeProject.id, {
        monthly_event_quota: parsed.value,
      })
      onSaved(result)
    } catch {
      setQuotaError('Could not save quota -- the value above was not changed on the server.')
    } finally {
      setQuotaSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Limits</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-retention-months">Retention (months)</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id="settings-retention-months"
              type="number"
              inputMode="numeric"
              className="max-w-32"
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              onClick={handleSaveRetention}
              disabled={retentionSaving}
            >
              Save retention
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Events older than this are purged. 1-120.</p>
          {retentionError && (
            <p role="alert" className="text-sm text-destructive">
              {retentionError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="settings-monthly-quota">Monthly event quota</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id="settings-monthly-quota"
              type="number"
              inputMode="numeric"
              placeholder="Unlimited"
              className="max-w-48"
              value={quotaInput}
              onChange={(e) => setQuotaInput(e.target.value)}
            />
            <Button type="button" size="sm" onClick={handleSaveQuota} disabled={quotaSaving}>
              Save quota
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Leave empty for unlimited.</p>
          {quotaError && (
            <p role="alert" className="text-sm text-destructive">
              {quotaError}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
