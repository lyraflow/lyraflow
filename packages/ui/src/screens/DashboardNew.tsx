import { useState } from 'react'
import { useNavigate } from 'react-router'
import { type ApiClient, ApiError } from '../api/client.js'
import { useProject } from '../app/ProjectContext.js'
import { dashboardPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'

/**
 * A name, nothing else. A dashboard is born empty and edited in place, so
 * there is no builder here -- the dashboard IS the builder. On 201 this
 * lands on the new dashboard in edit mode (`?edit=1`, read by `Dashboard`).
 */
export function DashboardNew(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (activeId == null || trimmed === '' || saving) return
    setSaving(true)
    setError(null)
    client
      .createDashboard(activeId, { name: trimmed })
      .then((d) => navigate(`${dashboardPath(d.id)}?edit=1`))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(
          err instanceof ApiError && err.status === 409
            ? 'A dashboard with that name already exists.'
            : 'Could not create the dashboard. Try again.',
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold">New dashboard</h1>
      <div className="flex flex-col gap-1">
        <Label htmlFor="dashboard-name">Name</Label>
        <Input
          id="dashboard-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
        />
      </div>
      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={trimmed === '' || saving}>
          Create dashboard
        </Button>
      </div>
    </form>
  )
}
