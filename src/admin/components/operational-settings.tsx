import { useRef, useState, type FormEvent } from "react"
import {
  Alert,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Switch,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/client"
import type { OperationalSettings } from "../../shared/operational-settings"
import {
  SettingsActions,
  SettingsCard,
  SettingsLoading,
  SettingsRow,
} from "./settings-section"
type Snapshot = {
  configured: boolean
  revision: number
  settings: OperationalSettings
  webhook_token_configured: boolean
}
type Field = {
  key: keyof OperationalSettings
  label: string
  choices?: [string, string][]
  min?: number
  max?: number
  step?: string
}
const groups: { title: string; fields: Field[] }[] = [
  {
    title: "Shipping",

    fields: [
      { key: "enabled", label: "Enable Shiprocket" },
      {
        key: "rounding_rupees",
        label: "Round customer shipping up to (₹)",
        choices: [
          ["1", "₹1"],
          ["10", "₹10"],
          ["50", "₹50"],
          ["100", "₹100"],
        ],
      },
      {
        key: "automatic_recovery",
        label: "Recover interrupted fulfillment attempts",
      },
    ],
  },
  {
    title: "Packing",

    fields: [
      {
        key: "multiple_items",
        label: "Multiple items",
        choices: [
          ["single_shipment", "One combined shipment"],
          ["split_shipment", "Split per physical unit"],
        ],
      },
      {
        key: "single_shipment_dimensions",
        label: "Combined package dimensions",
        choices: [
          ["largest_item", "Largest item"],
          ["stacked", "Stacked items"],
        ],
      },
      {
        key: "missing_measurements",
        label: "Missing product measurements",
        choices: [
          ["reject", "Require complete measurements"],
          ["use_defaults", "Use configured minimums"],
        ],
      },
      {
        key: "default_item_weight_grams",
        label: "Default item weight (g)",
        min: 0.001,
        max: 1000000,
        step: "any",
      },
      {
        key: "default_item_length_mm",
        label: "Default length (mm)",
        min: 5.001,
        max: 100000,
        step: "any",
      },
      {
        key: "default_item_width_mm",
        label: "Default width (mm)",
        min: 5.001,
        max: 100000,
        step: "any",
      },
      {
        key: "default_item_height_mm",
        label: "Default height (mm)",
        min: 5.001,
        max: 100000,
        step: "any",
      },
    ],
  },
  {
    title: "Courier selection",

    fields: [
      {
        key: "courier_selection",
        label: "Rank couriers by",
        choices: [
          ["lowest_price", "Lowest price"],
          ["highest_rating", "Highest rating"],
        ],
      },
      {
        key: "courier_fallback",
        label: "When preferences cannot be met",
        choices: [
          ["none", "Do not relax preferences"],
          ["relax_preferences", "Relax preferences"],
        ],
      },
      {
        key: "require_real_time_tracking",
        label: "Require real-time tracking",
      },
      {
        key: "require_call_before_delivery",
        label: "Require call before delivery",
      },
      {
        key: "pod_requirement",
        label: "Required proof of delivery",
        choices: [
          ["any", "Any"],
          ["instant", "Instant"],
          ["on_request", "On request"],
        ],
      },
      {
        key: "preferred_real_time_tracking",
        label: "Prefer real-time tracking",
      },
      {
        key: "preferred_call_before_delivery",
        label: "Prefer call before delivery",
      },
      {
        key: "preferred_pod",
        label: "Preferred proof of delivery",
        choices: [
          ["any", "Any"],
          ["instant", "Instant"],
          ["on_request", "On request"],
        ],
      },
    ],
  },
  {
    title: "API and documents",

    fields: [
      {
        key: "timeout",
        label: "API timeout (milliseconds)",
        min: 1000,
        max: 300000,
      },
      {
        key: "rate_cache_ttl_ms",
        label: "Rate cache lifetime (milliseconds)",
        min: 0,
        max: 3600000,
      },
      {
        key: "auto_assign_awb",
        label: "Assign AWB during fulfillment",
      },
      { key: "verify_documents", label: "Verify generated document links" },
      { key: "rate_diagnostics", label: "Log courier rate decisions" },
      {
        key: "webhook_payload_retention_days",
        label: "Raw tracking payload retention (days)",
        min: 1,
        max: 365,
      },
    ],
  },
]

const sections = [
  ...groups.map((group) => ({
    ...group,
    fields: group.fields.filter(
      (f) => f.key !== "webhook_payload_retention_days"
    ),
  })),
  {
    title: "Tracking webhook",

    fields: groups
      .flatMap((g) => g.fields)
      .filter((f) => f.key === "webhook_payload_retention_days"),
  },
]
function display(
  field: Field,
  value: OperationalSettings[keyof OperationalSettings]
) {
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled"
  if (field.choices)
    return (
      field.choices.find(([v]) => v === String(value))?.[1] ?? String(value)
    )
  if (field.key === "timeout") return `${Number(value) / 1000} seconds`
  if (field.key === "rate_cache_ttl_ms")
    return Number(value) === 0 ? "Disabled" : `${Number(value) / 1000} seconds`
  if (field.key === "webhook_payload_retention_days") return `${value} days`
  return `${value}${field.key === "default_item_weight_grams" ? " g" : field.key.startsWith("default_item_") ? " mm" : ""}`
}
const valuesFor = (data: Snapshot) =>
  Object.fromEntries(
    Object.entries(data.settings).map(([k, v]) => [
      k,
      typeof v === "boolean" ? v : String(v),
    ])
  )
export default function OperationalSettingsForm({
  canRead,
  canWrite,
}: {
  canRead: boolean
  canWrite: boolean
}) {
  const cache = useQueryClient(),
    prompt = usePrompt()
  const connection = useQuery({
    queryKey: ["shiprocket-settings"],
    enabled: canRead,
    retry: false,
    queryFn: () =>
      sdk.client.fetch<{ configured: boolean }>("/admin/shiprocket-settings"),
  })
  const query = useQuery({
    queryKey: ["shiprocket-operational-settings"],
    enabled: canRead,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      sdk.client.fetch<Snapshot>("/admin/shiprocket-settings/preferences"),
  })
  const [draft, setDraft] = useState<{
      index: number
      snapshot: Snapshot
    } | null>(null),
    [values, setValues] = useState<Record<string, string | boolean>>({}),
    [token, setToken] = useState("")
  const [busy, setBusy] = useState<"save" | "reload" | null>(null),
    [error, setError] = useState("")
  const returnFocus = useRef<HTMLElement | null>(null)
  const dirty = Boolean(
    draft &&
    (token ||
      JSON.stringify(values) !== JSON.stringify(valuesFor(draft.snapshot)))
  )
  const group = draft ? sections[draft.index] : null
  function begin(index: number, trigger: HTMLElement | null) {
    if (!query.data || !canWrite || !connection.data?.configured) return
    returnFocus.current = trigger
    setDraft({ index, snapshot: query.data })
    setValues(valuesFor(query.data))
    setToken("")
    setError("")
  }
  async function close() {
    if (busy) return
    if (
      dirty &&
      !(await prompt({
        title: "Discard changes?",
        description: "Your shipping settings changes have not been saved.",
        confirmText: "Discard",
        cancelText: "Keep editing",
      }))
    )
      return
    setDraft(null)
    setToken("")
    setError("")
  }
  async function reload() {
    if (busy || !draft) return
    if (
      dirty &&
      !(await prompt({
        title: "Discard changes?",
        description: "Reloading replaces your draft with the saved settings.",
        confirmText: "Reload",
        cancelText: "Keep editing",
      }))
    )
      return
    setBusy("reload")
    setError("")
    try {
      const data = (await query.refetch({ throwOnError: true })).data!
      setDraft({ index: draft.index, snapshot: data })
      setValues(valuesFor(data))
      setToken("")
    } catch {
      setError("Settings could not be reloaded. Your draft has been preserved.")
    } finally {
      setBusy(null)
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!canWrite || !draft || busy || !connection.data?.configured) return
    setBusy("save")
    setError("")
    try {
      const settings = Object.fromEntries(
        Object.entries(draft.snapshot.settings).map(([key, original]) => [
          key,
          typeof original === "number" ? Number(values[key]) : values[key],
        ])
      )
      const saved = await sdk.client.fetch<Snapshot>(
        "/admin/shiprocket-settings/preferences",
        {
          method: "POST",
          body: {
            settings,
            revision: draft.snapshot.revision,
            ...(token ? { webhook_token: token } : {}),
          },
        }
      )
      cache.setQueryData(["shiprocket-operational-settings"], saved)
      void cache.invalidateQueries({
        queryKey: ["shipping-measurement-policy"],
      })
      setDraft(null)
      setToken("")
      toast.success("Shipping settings updated")
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              "Reload and verify again.",
              "Reload saved settings and try again."
            )
          : "Settings could not be saved. Reload before retrying."
      )
    } finally {
      setBusy(null)
    }
  }
  if (!canRead) return null
  if (query.isPending || connection.isPending)
    return <SettingsLoading title="Shipping settings" />
  if (query.isError || connection.isError || !query.data)
    return (
      <SettingsCard title="Shipping settings">
        <div className="px-6 py-4">
          <Alert variant="error">Shipping settings could not be loaded.</Alert>
          <Button
            variant="secondary"
            size="small"
            className="mt-3"
            onClick={() => {
              void query.refetch()
              void connection.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      </SettingsCard>
    )
  return (
    <div className="flex flex-col gap-y-3">
      {!connection.data?.configured ? (
        <Alert variant="info">Configure and verify a connection first.</Alert>
      ) : (
        !query.data.configured && (
          <Alert variant="info">
            Save a section to manage these settings here.
          </Alert>
        )
      )}
      {sections.map((section, index) => (
        <SettingsCard
          key={section.title}
          title={section.title}

          action={
            canWrite && connection.data?.configured ? (
              <SettingsActions
                name={section.title}
                onEdit={(trigger) => begin(index, trigger)}
              />
            ) : undefined
          }
        >
          {section.fields.map((field) => (
            <SettingsRow
              key={field.key}
              label={field.label.replace(/ \((milliseconds|g|mm|days)\)/g, "")}
            >
              {display(field, query.data!.settings[field.key])}
            </SettingsRow>
          ))}
          {section.title === "Tracking webhook" && (
            <SettingsRow label="Webhook token">
              {query.data!.webhook_token_configured
                ? "Configured"
                : "Not configured"}
            </SettingsRow>
          )}
        </SettingsCard>
      ))}
      <Drawer
        open={Boolean(draft) && canWrite}
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
            <Drawer.Title>Edit {group?.title.toLowerCase()}</Drawer.Title>
            <Drawer.Description className="sr-only">
              Update the selected settings.
            </Drawer.Description>
          </Drawer.Header>
          <form
            onSubmit={save}
            className="flex min-h-0 flex-1 flex-col"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                e.currentTarget.requestSubmit()
              }
            }}
          >
            <Drawer.Body className="overflow-y-auto">
              <fieldset
                disabled={Boolean(busy)}
                className="flex flex-col gap-y-8"
              >
                {group?.fields.map((field) => {
                  const id = "shiprocket-setting-" + field.key,
                    help = id + "-help"
                  const hint =
                    field.key === "rate_cache_ttl_ms"
                      ? "Use 0 to disable caching."
                      : field.key === "auto_assign_awb"
                        ? "Pickup remains a separate action."
                        : undefined
                  const disabled =
                    Boolean(busy) ||
                    (field.key === "single_shipment_dimensions" &&
                      values.multiple_items !== "single_shipment") ||
                    (field.key.startsWith("default_item_") &&
                      values.missing_measurements !== "use_defaults")
                  return (
                    <div key={field.key} className="flex flex-col gap-y-2">
                      {typeof draft?.snapshot.settings[field.key] ===
                      "boolean" ? (
                        <div className="flex items-center justify-between gap-x-4">
                          <Label htmlFor={id}>{field.label}</Label>
                          <Switch
                            id={id}
                            aria-describedby={hint ? help : undefined}
                            checked={values[field.key] === true}
                            onCheckedChange={(v) =>
                              setValues((old) => ({ ...old, [field.key]: v }))
                            }
                            disabled={disabled}
                          />
                        </div>
                      ) : (
                        <>
                          <Label htmlFor={id}>{field.label}</Label>
                          {field.choices ? (
                            <Select
                              disabled={disabled}
                              value={String(values[field.key] ?? "")}
                              onValueChange={(v) =>
                                setValues((old) => ({ ...old, [field.key]: v }))
                              }
                            >
                              <Select.Trigger
                                id={id}
                                aria-describedby={hint ? help : undefined}
                              >
                                <Select.Value />
                              </Select.Trigger>
                              <Select.Content>
                                {field.choices.map(([value, label]) => (
                                  <Select.Item key={value} value={value}>
                                    {label}
                                  </Select.Item>
                                ))}
                              </Select.Content>
                            </Select>
                          ) : (
                            <Input
                              id={id}
                              aria-describedby={hint ? help : undefined}
                              type="number"
                              required
                              min={field.min}
                              max={field.max}
                              step={field.step ?? "1"}
                              value={String(values[field.key] ?? "")}
                              onChange={(e) =>
                                setValues((old) => ({
                                  ...old,
                                  [field.key]: e.target.value,
                                }))
                              }
                              disabled={disabled}
                            />
                          )}
                        </>
                      )}
                      {hint && (
                        <Text
                          id={help}
                          size="small"
                          className="text-ui-fg-subtle"
                        >
                          {hint}
                        </Text>
                      )}
                    </div>
                  )
                })}
                {group?.title === "Tracking webhook" && (
                  <div className="flex flex-col gap-y-2">
                    <Label htmlFor="shiprocket-webhook-token">
                      Webhook token
                    </Label>
                    <Input
                      id="shiprocket-webhook-token"
                      aria-describedby="shiprocket-webhook-help"
                      type="password"
                      autoComplete="new-password"
                      value={token}
                      minLength={32}
                      maxLength={1024}
                      placeholder={
                        draft?.snapshot.webhook_token_configured
                          ? "Leave blank to keep the saved token"
                          : "Enter at least 32 characters"
                      }
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <Text
                      id="shiprocket-webhook-help"
                      size="small"
                      className="text-ui-fg-subtle"
                    >
                      Use the same token in Shiprocket. Replacing it takes
                      effect immediately.
                    </Text>
                  </div>
                )}
              </fieldset>
              {error && (
                <div className="mt-6 flex flex-col gap-y-3">
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
                    Reload saved settings
                  </Button>
                </div>
              )}
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
                disabled={
                  Boolean(busy) || (!dirty && draft?.snapshot.configured)
                }
                isLoading={busy === "save"}
              >
                Save
              </Button>
            </Drawer.Footer>
          </form>
        </Drawer.Content>
      </Drawer>
    </div>
  )
}
