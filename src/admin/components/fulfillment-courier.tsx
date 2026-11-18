import { Badge, Button, RadioGroup, Text, clx } from "@medusajs/ui"
import { useEffect, useId, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/client"

type Service = "air" | "surface"
type Choice = {
  courier_company_id: number
  courier_name: string
  service: Service
  amount: number
  affordable: boolean
  estimated_delivery_days: string | null
}
type Catalog = {
  shipping_option_id: string
  package_id?: string
  service: Service
  selected_service: Service
  checkout_service: Service
  remaining_budget: number
  revision: string
  selected_courier_id: number
  couriers: Choice[]
}
type Selection = {
  courier_company_id: number
  courier_name: string
  service: Service
  amount?: number
  affordable?: boolean
  remaining_budget?: number
  over_budget_amount?: number
}
const serviceLabel = (service: Service) =>
  service === "air" ? "Air" : "Surface"
const hasPrice = (amount: unknown): amount is number =>
  typeof amount === "number" && Number.isFinite(amount) && amount >= 0
const price = (amount: number) => `₹${amount.toFixed(2)}`
const eta = (days: string | null) =>
  days ? `${days} ${Number(days) === 1 ? "day" : "days"}` : ""
class CourierRequestTimeout extends Error {}
async function request<T>(
  path: string,
  args: {
    query?: Record<string, string>
    method?: "POST"
    body?: Record<string, unknown>
  },
  timeout: number,
  timeoutMessage: string,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let onAbort: () => void
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort()
      const error = new Error("Request cancelled")
      error.name = "AbortError"
      reject(error)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      reject(new CourierRequestTimeout(timeoutMessage))
      controller.abort()
    }, timeout)
  })
  try {
    return await Promise.race([
      sdk.client.fetch<T>(path, { ...args, signal: controller.signal }),
      interrupted,
    ])
  } finally {
    clearTimeout(timer!)
    signal?.removeEventListener("abort", onAbort!)
  }
}

export const FulfillmentCourier = ({
  orderId,
  optionId,
  packageId,
  quote,
  parcelSummary,
  label = "shipment",
}: {
  orderId: string
  optionId: string
  packageId?: string
  quote: any
  parcelSummary?: string
  label?: string
}) => {
  const identity = JSON.stringify([orderId, optionId, packageId])
  const activeIdentity = useRef(identity)
  activeIdentity.current = identity
  const quoteKey = JSON.stringify([
    quote.courier_company_id,
    quote.courier_name,
    quote.service,
    quote.carrier_amount,
    quote.affordable,
    quote.remaining_budget,
    quote.over_budget_amount,
  ])
  const [confirmed, setConfirmed] = useState<{
    identity: string
    quoteKey: string
    selection: Selection
  }>()
  useEffect(() => {
    setConfirmed(undefined)
  }, [identity, quoteKey])
  const current =
    confirmed?.identity === identity && confirmed.quoteKey === quoteKey
      ? confirmed.selection
      : {
          courier_company_id: quote.courier_company_id,
          courier_name: quote.courier_name || "Courier selected",
          service:
            quote.service === "air" ? ("air" as const) : ("surface" as const),
          amount: quote.carrier_amount,
          affordable: quote.affordable,
          remaining_budget: quote.remaining_budget,
          over_budget_amount: quote.over_budget_amount,
        }
  const currentOverBudget = current.affordable === false
  const currentOverage = hasPrice(current.over_budget_amount)
    ? current.over_budget_amount
    : hasPrice(current.amount) && hasPrice(current.remaining_budget)
      ? Math.max(0, current.amount - current.remaining_budget)
      : undefined
  const sessionCounter = useRef(0)
  const [editor, setEditor] = useState<{
    identity: string
    session: number
    service?: Service
  }>()
  const open = editor?.identity === identity
  const service = open ? editor.service : undefined
  const session = editor?.session ?? 0
  const [selected, setSelected] = useState("")
  const [error, setError] = useState("")
  const [reconcile, setReconcile] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const changeRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const cache = useQueryClient()
  const queryKey = [
    "shiprocket-fulfillment-couriers",
    orderId,
    optionId,
    packageId,
    session,
    service ?? "selected",
  ]
  const catalog = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const data = await request<Catalog>(
        `/admin/shiprocket-fulfillment/${orderId}/couriers`,
        {
          query: {
            shipping_option_id: optionId,
            ...(packageId ? { package_id: packageId } : {}),
            ...(service ? { service } : {}),
          },
        },
        30000,
        "Couriers took too long to load. Retry to check availability.",
        signal
      )
      if (
        !["air", "surface"].includes(data.service) ||
        data.shipping_option_id !== optionId ||
        (packageId && data.package_id !== packageId) ||
        (service && data.service !== service) ||
        typeof data.revision !== "string" ||
        !data.revision ||
        !hasPrice(data.remaining_budget) ||
        !Array.isArray(data.couriers)
      )
        throw new Error(
          "Courier information changed. Retry to load current options."
        )
      return data
    },
    enabled: !!open && !reconcile,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const fresh =
    open &&
    !reconcile &&
    catalog.isSuccess &&
    !catalog.isFetching &&
    !catalog.isError
      ? catalog.data
      : undefined
  const mode = service ?? fresh?.service ?? current.service
  const couriers = fresh?.couriers.filter((row) => row.service === mode) || []
  const choice = couriers.find(
    (row) => String(row.courier_company_id) === selected && hasPrice(row.amount)
  )
  useEffect(() => {
    setSelected("")
    if (fresh && fresh.selected_service === fresh.service) {
      const previous = fresh?.couriers.find(
        (row) =>
          row.service === fresh.service &&
          row.courier_company_id === fresh.selected_courier_id &&
          hasPrice(row.amount)
      )
      if (previous) setSelected(String(previous.courier_company_id))
    }
  }, [catalog.dataUpdatedAt, session, service])
  useEffect(() => {
    if (open)
      editorRef.current
        ?.querySelector<HTMLButtonElement>(
          '[role="radio"][aria-checked="true"]'
        )
        ?.focus()
  }, [open])
  const restoreFocus = () =>
    requestAnimationFrame(() => changeRef.current?.focus())
  const close = () => {
    if (savingRef.current) return
    setEditor(undefined)
    setSelected("")
    setError("")
    setReconcile(false)
    void cache.cancelQueries({ queryKey, exact: true }).catch(() => {})
    restoreFocus()
  }
  const begin = () => {
    setSelected("")
    setError("")
    setReconcile(false)
    setEditor({ identity, session: ++sessionCounter.current })
  }
  const changeService = (value: string) => {
    if (
      savingRef.current ||
      (value !== "air" && value !== "surface") ||
      value === mode
    )
      return
    void cache.cancelQueries({ queryKey, exact: true }).catch(() => {})
    setSelected("")
    setError("")
    setReconcile(false)
    setEditor((previous) => previous && { ...previous, service: value })
  }
  const retry = () => {
    setSelected("")
    setError("")
    setReconcile(false)
    setEditor(
      (previous) =>
        previous && { ...previous, session: ++sessionCounter.current }
    )
  }
  const save = async () => {
    if (!fresh || !choice || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError("")
    try {
      const result = await request<Selection>(
        `/admin/shiprocket-fulfillment/${orderId}/couriers`,
        {
          method: "POST",
          body: {
            shipping_option_id: optionId,
            ...(packageId ? { package_id: packageId } : {}),
            service: fresh.service,
            courier_company_id: choice.courier_company_id,
            amount: choice.amount,
            revision: fresh.revision,
          },
        },
        60000,
        "The courier change could not be confirmed. Refresh couriers before trying again."
      )
      if (activeIdentity.current !== identity) return
      const amount = hasPrice(result.amount) ? result.amount : choice.amount
      const remainingBudget = hasPrice(result.remaining_budget)
        ? result.remaining_budget
        : fresh.remaining_budget
      setConfirmed({
        identity,
        quoteKey,
        selection: {
          courier_company_id: choice.courier_company_id,
          courier_name: result.courier_name || choice.courier_name,
          service: fresh.service,
          amount,
          affordable:
            typeof result.affordable === "boolean"
              ? result.affordable
              : amount <= remainingBudget,
          remaining_budget: remainingBudget,
          over_budget_amount: hasPrice(result.over_budget_amount)
            ? result.over_budget_amount
            : Math.max(0, amount - remainingBudget),
        },
      })
      setEditor(undefined)
      setSelected("")
      restoreFocus()
      // The confirmed save is complete. Background order reads must not hold the editor open.
      void cache.invalidateQueries({ queryKey: ["orders"] }).catch(() => {})
      void cache
        .invalidateQueries({ queryKey: ["shiprocket-packages", orderId] })
        .catch(() => {})
    } catch (cause) {
      if (activeIdentity.current !== identity) return
      setSelected("")
      setError(
        cause instanceof Error
          ? cause.message
          : "The courier could not be saved. Try again."
      )
      if (cause instanceof CourierRequestTimeout) setReconcile(true)
      else
        setEditor(
          (previous) =>
            previous && { ...previous, session: ++sessionCounter.current }
        )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !savingRef.current) {
          event.preventDefault()
          close()
        }
      }}
    >
      {!open ? (
        <div className="flex flex-col gap-y-2">
          <div className="flex items-start justify-between gap-x-4">
            <div className="min-w-0">
              <Text size="small" weight="plus" className="break-words">
                {current.courier_name}
              </Text>
              <Text size="small" className="text-ui-fg-subtle">
                {[serviceLabel(current.service), parcelSummary]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </div>
            <div className="flex shrink-0 items-center gap-x-3">
              {hasPrice(current.amount) && (
                <Text size="small" className="text-ui-fg-subtle">
                  {price(current.amount)}
                </Text>
              )}
              <Button
                ref={changeRef}
                type="button"
                size="small"
                variant="transparent"
                aria-label={`Change courier for ${label}`}
                onClick={begin}
                disabled={saving}
              >
                Change
              </Button>
            </div>
          </div>
          {currentOverBudget && (
            <div className="flex flex-col gap-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge color="orange" size="small">
                  Over budget
                </Badge>
                {hasPrice(currentOverage) && (
                  <Text size="small" className="text-ui-fg-subtle">
                    {price(currentOverage)} over budget
                  </Text>
                )}
              </div>
              <Text size="small" className="text-ui-fg-subtle">
                The merchant covers the extra shipping cost. The customer charge
                stays unchanged.
              </Text>
            </div>
          )}
        </div>
      ) : (
        <div
          ref={editorRef}
          role="group"
          aria-labelledby={`${id}-heading`}
          className="flex max-w-xl flex-col gap-y-4"
          style={{ maxWidth: 576 }}
        >
          <div>
            <Text id={`${id}-heading`} size="small" weight="plus">
              Choose courier
            </Text>
            {parcelSummary && (
              <Text size="small" className="text-ui-fg-subtle">
                {parcelSummary}
              </Text>
            )}
          </div>
          <RadioGroup
            aria-label="Delivery service"
            orientation="horizontal"
            value={mode}
            onValueChange={changeService}
            onKeyDownCapture={(event) => {
              if (
                (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return
              event.preventDefault()
              if (savingRef.current) return
              const next = mode === "surface" ? "air" : "surface"
              changeService(next)
              document.getElementById(`${id}-${next}`)?.focus()
            }}
            disabled={saving}
            className="flex gap-x-2"
          >
            {(["surface", "air"] as const).map((value) => (
              <label
                key={value}
                htmlFor={`${id}-${value}`}
                className={clx(
                  "flex cursor-pointer items-center gap-x-2 rounded-md border px-3 py-1.5 text-ui-fg-base",
                  mode === value
                    ? "border-ui-border-interactive bg-ui-bg-highlight"
                    : "border-ui-border-base bg-ui-bg-base",
                  saving && "cursor-not-allowed opacity-50"
                )}
              >
                <RadioGroup.Item id={`${id}-${value}`} value={value} />
                <Text size="small">{serviceLabel(value)}</Text>
              </label>
            ))}
          </RadioGroup>
          {catalog.isFetching && !reconcile && (
            <Text size="small" role="status" className="text-ui-fg-subtle">
              Loading couriers…
            </Text>
          )}
          {(error || catalog.isError) && (
            <Text size="small" role="alert" className="text-ui-fg-error">
              {error ||
                (catalog.error instanceof Error
                  ? catalog.error.message
                  : "Couriers could not be loaded. Try again.")}
            </Text>
          )}
          {(reconcile || catalog.isError) && (
            <Button
              type="button"
              size="small"
              variant="secondary"
              onClick={retry}
            >
              {reconcile ? "Refresh couriers" : "Retry"}
            </Button>
          )}
          {fresh && (
            <>
              {couriers.length ? (
                <RadioGroup
                  aria-label="Available couriers"
                  value={selected}
                  onValueChange={(value) => {
                    setSelected(value)
                    setError("")
                  }}
                  disabled={saving}
                  className="gap-y-2"
                >
                  {couriers.map((row) => {
                    const available = hasPrice(row.amount)
                    const description = [
                      hasPrice(row.amount)
                        ? price(row.amount)
                        : "Price unavailable",
                      eta(row.estimated_delivery_days),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                    return (
                      <label
                        key={row.courier_company_id}
                        htmlFor={`${id}-courier-${row.courier_company_id}`}
                        className={clx(
                          "shadow-borders-base bg-ui-bg-base flex items-start gap-x-2 rounded-md px-3 py-3 transition-fg focus-within:shadow-borders-interactive-with-focus",
                          saving || !available
                            ? "cursor-not-allowed opacity-50"
                            : "cursor-pointer hover:bg-ui-bg-base-hover",
                          selected === String(row.courier_company_id) &&
                            "shadow-borders-interactive-with-shadow"
                        )}
                      >
                        <RadioGroup.Item
                          id={`${id}-courier-${row.courier_company_id}`}
                          value={String(row.courier_company_id)}
                          disabled={saving || !available}
                          className="shrink-0"
                          aria-describedby={`${id}-courier-${row.courier_company_id}-description`}
                          aria-label={row.courier_name}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-y-1">
                          <Text as="span" size="small" weight="plus">
                            {row.courier_name}
                          </Text>
                          <span
                            id={`${id}-courier-${row.courier_company_id}-description`}
                            className="flex flex-col gap-y-2"
                          >
                            <Text
                              as="span"
                              size="small"
                              className="text-ui-fg-subtle"
                            >
                              {description}
                            </Text>
                            {row.affordable === false && available && (
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <Badge color="orange" size="small">
                                  Over budget
                                </Badge>
                                <Text
                                  as="span"
                                  size="small"
                                  className="text-ui-fg-subtle"
                                >
                                  {price(
                                    Math.max(
                                      0,
                                      row.amount - fresh.remaining_budget
                                    )
                                  )}{" "}
                                  over budget
                                </Text>
                              </span>
                            )}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </RadioGroup>
              ) : (
                <Text size="small" className="text-ui-fg-subtle">
                  No eligible couriers available for this service.
                </Text>
              )}
              {choice?.affordable === false && (
                <Text size="small" role="status" className="text-ui-fg-subtle">
                  The merchant covers the extra shipping cost. The customer
                  charge stays unchanged.
                </Text>
              )}
            </>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ui-border-base pt-3">
            <Button
              type="button"
              size="small"
              variant="secondary"
              onClick={close}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="small"
              onClick={save}
              disabled={saving || !fresh || !choice}
              aria-busy={saving}
            >
              {saving ? "Saving courier…" : "Save courier"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
