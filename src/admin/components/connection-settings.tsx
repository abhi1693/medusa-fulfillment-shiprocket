import {
  Alert,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useRef, useState, type FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/client"
import {
  SettingsActions,
  SettingsCard,
  SettingsLoading,
  SettingsRow,
} from "./settings-section"
type Settings = {
  configured: boolean
  email: string
  mode: "test" | "live"
  revision: number
  verified_at: string | null
}
type Draft = {
  email: string
  password: string
  mode: "test" | "live"
  revision: number
}
export default function ShiprocketConnectionSettings({
  canRead,
  canWrite,
}: {
  canRead: boolean
  canWrite: boolean
}) {
  const cache = useQueryClient(),
    prompt = usePrompt()
  const query = useQuery({
    queryKey: ["shiprocket-settings"],
    enabled: canRead,
    retry: false,
    queryFn: () => sdk.client.fetch<Settings>("/admin/shiprocket-settings"),
  })
  const [form, setForm] = useState<Draft | null>(null),
    [initial, setInitial] = useState<Draft | null>(null)
  const [proof, setProof] = useState<{
    verification: string
    expires_at: string
  } | null>(null)
  const [busy, setBusy] = useState<"verify" | "save" | "reload" | null>(null),
    [error, setError] = useState("")
  const returnFocus = useRef<HTMLElement | null>(null),
    formRef = useRef<HTMLFormElement | null>(null)
  const dirty = Boolean(
    form && JSON.stringify(form) !== JSON.stringify(initial)
  )
  function begin(trigger: HTMLElement | null) {
    if (!query.data || !canWrite) return
    returnFocus.current = trigger
    const draft = {
      email: query.data.email,
      password: "",
      mode: query.data.mode,
      revision: query.data.revision,
    }
    setForm(draft)
    setInitial(draft)
    setProof(null)
    setError("")
  }
  async function close() {
    if (busy) return
    if (
      dirty &&
      !(await prompt({
        title: "Discard changes?",
        description: "Your connection changes have not been saved.",
        confirmText: "Discard",
        cancelText: "Keep editing",
      }))
    )
      return
    setForm(null)
    setProof(null)
    setError("")
  }
  function update(value: Partial<Draft>) {
    setForm((current) => (current ? { ...current, ...value } : null))
    setProof(null)
    setError("")
  }
  async function verify() {
    if (!form || busy || !canWrite || !formRef.current?.reportValidity()) return
    setBusy("verify")
    setProof(null)
    setError("")
    try {
      setProof(
        await sdk.client.fetch<{ verification: string; expires_at: string }>(
          "/admin/shiprocket-settings/verify",
          { method: "POST", body: form }
        )
      )
    } catch {
      setError(
        "Verification failed. Check the API-user email, password and mode, then try again."
      )
    } finally {
      setBusy(null)
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!form || !proof || busy || !canWrite) return
    if (Date.parse(proof.expires_at) <= Date.now()) {
      setProof(null)
      setError("Verification expired. Test the connection again.")
      return
    }
    setBusy("save")
    setError("")
    try {
      const saved = await sdk.client.fetch<Settings>(
        "/admin/shiprocket-settings",
        { method: "POST", body: { ...form, verification: proof.verification } }
      )
      cache.setQueryData(["shiprocket-settings"], saved)
      void cache.invalidateQueries({ queryKey: ["shiprocket-pickup-mappings"] })
      void cache.invalidateQueries({ queryKey: ["shiprocket-pickups"] })
      setForm(null)
      setProof(null)
      toast.success("Connection saved")
    } catch (e) {
      setProof(null)
      setError(
        e instanceof Error
          ? e.message
          : "Connection could not be saved. Reload and verify again."
      )
    } finally {
      setBusy(null)
    }
  }
  async function reload() {
    if (busy) return
    if (
      dirty &&
      !(await prompt({
        title: "Discard changes?",
        description: "Reloading replaces your draft with the saved connection.",
        confirmText: "Reload",
        cancelText: "Keep editing",
      }))
    )
      return
    setBusy("reload")
    setError("")
    try {
      const data = (await query.refetch({ throwOnError: true })).data!
      const draft = {
        email: data.email,
        password: "",
        mode: data.mode,
        revision: data.revision,
      }
      setForm(draft)
      setInitial(draft)
      setProof(null)
    } catch {
      setError(
        "The saved connection could not be loaded. Your draft has been preserved."
      )
    } finally {
      setBusy(null)
    }
  }
  if (!canRead)
    return (
      <SettingsCard title="API connection">
        <Text className="px-6 py-4">
          You do not have permission to view these settings.
        </Text>
      </SettingsCard>
    )
  if (query.isPending) return <SettingsLoading title="API connection" />
  if (query.isError || !query.data)
    return (
      <SettingsCard title="API connection">
        <div className="px-6 py-4">
          <Alert variant="error">Connection could not be loaded.</Alert>
          <Button
            variant="secondary"
            size="small"
            className="mt-3"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </div>
      </SettingsCard>
    )
  const data = query.data
  return (
    <>
      <SettingsCard
        title="API connection"
        action={
          canWrite && data.configured ? (
            <SettingsActions name="API connection" onEdit={begin} />
          ) : undefined
        }
      >
        {data.configured ? (
          <>
            <SettingsRow label="API-user email">{data.email}</SettingsRow>
            <SettingsRow label="Mode">
              <Badge
                color={data.mode === "live" ? "green" : "grey"}
                size="2xsmall"
              >
                {data.mode === "live" ? "Live" : "Test"}
              </Badge>
            </SettingsRow>
            <SettingsRow label="API password">Configured</SettingsRow>
            <SettingsRow label="Last verified">
              {data.verified_at
                ? new Date(data.verified_at).toLocaleString()
                : "—"}
            </SettingsRow>
          </>
        ) : (
          <div className="px-6 py-8">
            <Text size="small" className="text-ui-fg-subtle">
              No connection configured.
            </Text>
            {canWrite && (
              <Button
                size="small"
                variant="secondary"
                className="mt-3"
                onClick={(e) => begin(e.currentTarget)}
              >
                Configure connection
              </Button>
            )}
          </div>
        )}
      </SettingsCard>
      <Drawer
        open={Boolean(form) && canWrite}
        onOpenChange={(open) => {
          if (!open) void close()
        }}
      >
        <Drawer.Content
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopImmediatePropagation()
            void close()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocus.current?.focus()
          }}
        >
          <Drawer.Header>
            <Drawer.Title>
              {data.configured ? "Edit connection" : "Configure connection"}
            </Drawer.Title>
            <Drawer.Description className="sr-only">
              Verify the connection before saving credentials.
            </Drawer.Description>
          </Drawer.Header>
          <form
            ref={formRef}
            onSubmit={save}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Drawer.Body className="overflow-y-auto">
              <div className="flex flex-col gap-y-8">
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="shiprocket-email">API-user email</Label>
                  <Input
                    id="shiprocket-email"
                    type="email"
                    required
                    autoComplete="off"
                    maxLength={254}
                    value={form?.email ?? ""}
                    disabled={Boolean(busy)}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="shiprocket-password">API password</Label>
                  <Input
                    id="shiprocket-password"
                    type="password"
                    required={!data.configured}
                    autoComplete="new-password"
                    maxLength={1024}
                    value={form?.password ?? ""}
                    disabled={Boolean(busy)}
                    onChange={(e) => update({ password: e.target.value })}
                    placeholder={
                      data.configured
                        ? "Leave blank to keep the saved password"
                        : "Enter API password"
                    }
                  />
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="shiprocket-mode">Mode</Label>
                  <Select
                    value={form?.mode ?? "test"}
                    disabled={Boolean(busy)}
                    onValueChange={(mode) =>
                      update({ mode: mode as "test" | "live" })
                    }
                  >
                    <Select.Trigger id="shiprocket-mode">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="test">Test</Select.Item>
                      <Select.Item value="live">Live</Select.Item>
                    </Select.Content>
                  </Select>
                  <Text size="small" className="text-ui-fg-subtle">
                    Changing the account or mode requires relinking pickups.
                  </Text>
                </div>
                <div className="flex flex-col gap-y-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={Boolean(busy)}
                    isLoading={busy === "verify"}
                    onClick={verify}
                  >
                    Test connection
                  </Button>

                  {proof && (
                    <Alert variant="success" role="status">
                      Connection verified.
                    </Alert>
                  )}
                  {error && (
                    <>
                      <Alert variant="error" role="alert">
                        {error}
                      </Alert>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={Boolean(busy)}
                        onClick={reload}
                      >
                        Reload saved connection
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                type="button"
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={Boolean(busy) || !proof}
                isLoading={busy === "save"}
              >
                Save
              </Button>
            </Drawer.Footer>
          </form>
        </Drawer.Content>
      </Drawer>
    </>
  )
}
