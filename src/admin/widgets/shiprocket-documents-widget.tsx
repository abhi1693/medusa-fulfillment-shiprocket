import { useQueryClient } from "@tanstack/react-query"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import {
  Container,
  Heading,
  Badge,
  Text,
  Copy,
  Button,
  Select,
} from "@medusajs/ui"
import { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { useState, useEffect } from "react"
import { sdk } from "../lib/client"
import {
  ArrowPath,
  DocumentText,
  SquareTwoStack,
  ListBullet,
  ArrowUpRightOnBox,
} from "@medusajs/icons"
// @ts-ignore
import logo from "../../assets/logo.png"

/**
 * Shiprocket Documents Widget
 *
 * Displays shipment documents and tracking links for easy access.
 * Shows: AWB, Tracking URL, Label, Invoice, and Manifest downloads.
 */
const ShiprocketDocumentsWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const queryClient = useQueryClient()
  // Defines extended fulfillment type to include labels
  type ShiprocketFulfillment = NonNullable<
    AdminOrder["fulfillments"]
  >[number] & {
    labels?: Array<{
      tracking_number?: string
      tracking_url?: string
      label_url?: string
    }>
  }

  const [selectedFulfillment, setSelectedFulfillment] = useState<
    string | undefined
  >()
  const fulfillments = data?.fulfillments || []

  // Find Shiprocket fulfillment - Medusa v2 formats provider_id as "fp_{module}_{identifier}"
  // e.g. "fp_shiprocket_shiprocket", so we check with includes() for robustness
  const shipments = fulfillments.filter(
    (f) =>
      f.provider_id?.toLowerCase().includes("shiprocket") ||
      f.data?.courier_name
  )
  const shiprocketFulfillment = (shipments.find(
    (f) => f.id === selectedFulfillment
  ) || shipments[0]) as ShiprocketFulfillment | undefined

  // Widget State
  const [tracking, setTracking] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [assignedAwb, setAssignedAwb] = useState<string | undefined>()
  const [scheduling, setScheduling] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedDocs, setFetchedDocs] = useState<any>(null)

  // Extract basic info from fulfillment
  const label = shiprocketFulfillment?.labels?.[0]
  const awb = (assignedAwb ||
    label?.tracking_number ||
    shiprocketFulfillment?.data?.awb) as string

  // Document URLs (Prioritize fetched, then props)
  const labelUrl = (fetchedDocs?.label_url ||
    label?.label_url ||
    shiprocketFulfillment?.data?.label_url) as string
  const invoiceUrl = (fetchedDocs?.invoice_url ||
    shiprocketFulfillment?.data?.invoice_url) as string
  const manifestUrl = (fetchedDocs?.manifest_url ||
    shiprocketFulfillment?.data?.manifest_url) as string

  const documentStatus =
    fetchedDocs?.status ||
    shiprocketFulfillment?.data?.shiprocket_document_status

  const documentFailure = Object.entries(documentStatus || {})
    .filter(([, value]: any) => value?.available === false)
    .map(([kind, value]: any) => `${kind}: ${value.message}`)
    .join("; ")

  const trackingUrl = (label?.tracking_url ||
    (awb
      ? `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`
      : null)) as string
  const courierName = shiprocketFulfillment?.data?.courier_name as string

  useEffect(() => {
    setAssignedAwb(undefined)
    setFetchedDocs(null)
    setTracking(null)
    setError(null)
  }, [shiprocketFulfillment?.id])

  const assignAwb = async () => {
    if (!shiprocketFulfillment?.id || assigning) return
    setAssigning(true)
    setError(null)
    try {
      const result = await sdk.client.fetch<any>(
        `/admin/shiprocket/fulfillments/${encodeURIComponent(shiprocketFulfillment.id)}/awb`,
        { method: "POST" }
      )
      if (!result.success || !result.awb)
        throw Error(result.message || "AWB assignment was not confirmed")
      setAssignedAwb(result.awb)
      if (result.documents) setFetchedDocs(result.documents)
      if (result.documents && !result.documents.label_url)
        setError(
          result.documents?.status?.label?.message ||
            "AWB assigned. Shiprocket has not returned an available label. Sync to retry documents."
        )
      await queryClient.invalidateQueries()
    } catch (error) {
      setError(error instanceof Error ? error.message : "AWB assignment failed")
    } finally {
      setAssigning(false)
    }
  }

  // Fetch tracking on mount if AWB is present
  useEffect(() => {
    if (!awb) return

    let active = true
    setLoading(true)
    sdk.client
      .fetch<any>(`/admin/shiprocket/tracking/${encodeURIComponent(awb)}`)
      .then((result) => {
        if (active && result?.success && result.tracking) {
          setTracking(result.tracking)
        }
      })
      .catch(() => {
        /* silent fail for initial load */
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [awb])

  const syncTracking = async () => {
    if (!awb || syncing) return
    setSyncing(true)
    setError(null)

    try {
      const result = await sdk.client.fetch<any>(
        `/admin/shiprocket/tracking/${encodeURIComponent(awb)}/sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: { fulfillment_id: shiprocketFulfillment?.id },
        }
      )
      if (result.success) {
        // Update documents if returned
        if (result.documents) {
          setFetchedDocs(result.documents)
          if (
            !result.documents.label_url ||
            (result.pickup?.scheduled && !result.documents.manifest_url)
          )
            setError(
              "Shiprocket has not returned all shipment documents. Sync to retry."
            )
          const failures = Object.entries(result.documents.status || {})
            .filter(([, value]: any) => value?.available === false)
            .map(([kind, value]: any) => `${kind}: ${value.message}`)
          if (failures.length) setError(failures.join("; "))
        }

        if (result.pickup === undefined)
          setError("Carrier pickup state could not be verified. Sync to retry.")
        // Refresh tracking
        const trackData = await sdk.client.fetch<any>(
          `/admin/shiprocket/tracking/${encodeURIComponent(awb)}`
        )
        if (trackData?.success && trackData.tracking) {
          setTracking({
            ...trackData.tracking,
            pickup_confirmed: result.pickup?.scheduled,
          })
        }
        await queryClient.invalidateQueries()
      } else {
        setError(result.message || "Sync failed")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync tracking")
    } finally {
      setSyncing(false)
    }
  }

  const schedulePickup = async () => {
    if (!awb || scheduling) return
    setScheduling(true)
    setError(null)

    try {
      const result = await sdk.client.fetch<any>(
        `/admin/shiprocket/tracking/${encodeURIComponent(awb)}/pickup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { fulfillment_id: shiprocketFulfillment?.id },
        }
      )
      if (result.success && result.pickup?.scheduled) {
        setTracking((previous: any) => ({
          ...previous,
          pickup_confirmed: true,
        }))
        await syncTracking()
      } else {
        setError(result.message || "Failed to schedule pickup")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule pickup")
    } finally {
      setScheduling(false)
    }
  }

  const cancelShipment = async () => {
    if (!shiprocketFulfillment?.id || canceling) return
    if (
      !confirm(
        "Are you sure you want to cancel this entire shipment? This action cannot be undone and will void the AWB."
      )
    )
      return

    setCanceling(true)
    setError(null)

    try {
      await sdk.admin.order.cancelFulfillment(
        data.id,
        shiprocketFulfillment.id,
        {}
      )
      setTracking((previous: any) => ({
        ...previous,
        current_status: "CANCELLED",
      }))
      await queryClient.invalidateQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel shipment")
    } finally {
      setCanceling(false)
    }
  }

  const humanizeStatus = (text: string) => {
    if (!text) return ""
    const s = text.toUpperCase().replace(/[\s_-]/g, "")

    // Common Shiprocket merged statuses mapping
    const validStatuses: Record<string, string> = {
      READYFORRECEIVE: "Ready For Receive",
      PICKUPCANCELLED: "Pickup Cancelled",
      OUTFORPICKUP: "Out For Pickup",
      PICKUPGENERATED: "Pickup Generated",
      PICKUPSCHEDULED: "Pickup Scheduled",
      PICKUPQUEUED: "Pickup Queued",
      PICKUPRESCHEDULED: "Pickup Rescheduled",
      PICKUPPICKEDUP: "Pickup Picked Up",
      AWBASSIGNED: "AWB assigned",
      AWBPENDING: "AWB pending",
      LABELGENERATED: "Label Generated",
      MANIFESTGENERATED: "Manifest Generated",
      INTRANSIT: "In Transit",
      OUTFORDELIVERY: "Out For Delivery",
      DELIVERED: "Delivered",
      CANCELLED: "Cancelled",
      RTOINITIATED: "RTO Initiated",
      RTODELIVERED: "RTO Delivered",
      RTOACKNOWLEDGED: "RTO Acknowledged",
      LOST: "Lost",
      DAMAGED: "Damaged",
      DESTROYED: "Destroyed",
      DISPOSEOFF: "Dispose Off",
    }

    if (validStatuses[s]) return validStatuses[s]

    // Fallback: Title Case replacing underscores/dashes, handling simple spacing if possible
    return text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .trim()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
  }

  const getStatusColor = (status: string) => {
    const s = status?.toUpperCase() || ""
    if (s.includes("DELIVER")) return "green"
    if (s.includes("TRANSIT") || s.includes("SHIPPED")) return "blue"
    if (s.includes("PICKUP") || s.includes("PICKED")) return "purple"
    if (s.includes("RTO") || s.includes("RETURN")) return "orange"
    if (s.includes("CANCEL") || s.includes("ERROR") || s.includes("EXCEPTION"))
      return "red"
    return "grey"
  }

  if (!shiprocketFulfillment) return null

  // Determine the most relevant status to show
  let displayStatus =
    tracking?.current_status || (awb ? "AWB ASSIGNED" : "AWB PENDING")

  // If we have scans, check if the latest scan is more critical/current than the top-level status
  // (e.g., if top is "AWB ASSIGNED" but latest scan is "PICKUP CANCELLED")
  if (tracking?.scans?.length > 0) {
    const latestScan = tracking.scans[tracking.scans.length - 1] // Last item is usually latest in Shiprocket array, check mapping below
    // The API array might vary, but we reversed it in the map previously using slice().reverse().
    // Let's assume 'scans' is chronological. In the UI map we slice().reverse(), so array is [oldest, ..., newest].
    // Wait, normally API returns chronological. The UI map was `.slice().reverse()`, implying the last element in raw data is the newest.
    const latestActivity = latestScan.activity || latestScan.status || ""

    // If the latest activity implies a terminal or critical state, override generic "AWB ASSIGNED"
    if (
      latestActivity.toUpperCase().includes("CANCELLED") ||
      latestActivity.toUpperCase().includes("DELIVERED") ||
      latestActivity.toUpperCase().includes("RTO")
    ) {
      displayStatus = latestActivity
    }
  }

  // If Medusa order or fulfillment is canceled, override status to CANCELLED (if not already cancellation status)
  const isCanceled =
    !!shiprocketFulfillment?.canceled_at ||
    data?.status === "canceled" ||
    displayStatus.toUpperCase().includes("CANCEL")

  if (isCanceled && !displayStatus.toUpperCase().includes("CANCEL")) {
    displayStatus = "CANCELLED"
  }

  const humanStatus = humanizeStatus(displayStatus)

  // Check if pickup is already scheduled based on scans or direct property
  const isScheduled =
    tracking?.pickup_confirmed ||
    shiprocketFulfillment?.data?.shiprocket_pickup_confirmed ||
    tracking?.scans?.some(
      (s: any) =>
        s.activity?.toUpperCase().includes("SCHEDULED") ||
        s.status?.toUpperCase().includes("SCHEDULED")
    ) ||
    tracking?.pickup_scheduled_date

  return (
    <Container className="p-0 overflow-hidden border border-ui-border-base bg-ui-bg-base/50 shadow-elevation-card-rest">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-ui-border-base bg-ui-bg-base">
        <div className="flex items-center gap-x-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-ui-border-base bg-ui-bg-base overflow-hidden p-1.5">
            <img
              src={logo}
              alt="Shiprocket"
              className="h-full w-full object-contain mix-blend-multiply dark:mix-blend-normal"
            />
          </div>
          <div>
            <Heading
              level="h2"
              className="text-sm font-medium text-ui-fg-base mb-0.5"
            >
              Shipment & Tracking
            </Heading>
            <Text size="xsmall" className="text-ui-fg-muted font-medium">
              {tracking?.courier_name ||
                courierName ||
                "Shiprocket Fulfillment"}
            </Text>
          </div>
        </div>
        {humanStatus && (
          <Badge
            color={getStatusColor(humanStatus)}
            size="xsmall"
            className="shrink-0 whitespace-nowrap"
          >
            {humanStatus}
          </Badge>
        )}
      </div>

      {shipments.length > 1 && (
        <div className="px-6 py-3 border-b border-ui-border-base">
          <Select
            value={shiprocketFulfillment?.id}
            onValueChange={setSelectedFulfillment}
            disabled={assigning || scheduling || syncing || canceling}
          >
            <Select.Trigger aria-label="Select shipment">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {shipments.map((f, index) => (
                <Select.Item key={f.id} value={f.id}>
                  Shipment {index + 1}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      )}
      {/* Tracking ID & Sync */}
      <div className="px-6 py-4 border-b border-ui-border-base">
        <div className="flex items-center justify-between">
          <div>
            <Text size="xsmall" className="text-ui-fg-subtle mb-1 block">
              AWB Number
            </Text>
            <div className="flex items-center gap-x-2">
              <Text
                className={`break-all text-ui-fg-base ${awb ? "font-mono text-base" : "text-sm"}`}
              >
                {awb || "Not assigned"}
              </Text>
              {awb && (
                <Copy
                  content={awb}
                  className="text-ui-fg-muted transition-colors hover:text-ui-fg-base"
                />
              )}
            </div>
          </div>
          {awb && (
            <Button
              variant="secondary"
              size="small"
              aria-label="Sync tracking and documents"
              onClick={syncTracking}
              disabled={syncing}
              className="bg-ui-bg-base hover:bg-ui-bg-subtle h-8 w-8 p-0 border-ui-border-strong shadow-sm group"
            >
              <ArrowPath
                className={`w-3.5 h-3.5 ${syncing ? "animate-spin text-ui-fg-interactive" : "text-ui-fg-subtle group-hover:text-ui-fg-base"}`}
              />
            </Button>
          )}
        </div>

        {/* Shipment Specs */}
        {(tracking?.weight || tracking?.origin) && (
          <div className="flex flex-wrap items-center gap-3 pt-3">
            {tracking.weight && (
              <div className="flex items-center gap-x-1.5 px-2 py-0.5 rounded bg-ui-bg-component border border-ui-border-base shadow-sm">
                <Text size="xsmall" className="text-ui-fg-muted">
                  ⚖️
                </Text>
                <Text size="xsmall" weight="plus" className="text-ui-fg-base">
                  {tracking.weight} kg
                </Text>
              </div>
            )}
            {tracking.origin && (
              <div className="flex items-center gap-x-1.5">
                <Text size="xsmall" className="text-ui-fg-muted">
                  📍
                </Text>
                <Text
                  size="xsmall"
                  weight="plus"
                  className="text-ui-fg-base break-words"
                >
                  {tracking.origin}{" "}
                  <span className="text-ui-fg-muted mx-0.5">→</span>{" "}
                  {tracking.destination || "Dest"}
                </Text>
              </div>
            )}
          </div>
        )}

        {/* Sync info & Error */}
        {(awb || error || documentFailure) && (
          <div className="flex flex-wrap items-start justify-between gap-2 mt-3">
            <Text size="xsmall" className="text-ui-fg-muted font-medium">
              {tracking?.updated_at
                ? `Updated: ${new Date(tracking.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                : "Tracking has not been synced"}
            </Text>
            {(error || documentFailure) && (
              <Text
                role="alert"
                size="xsmall"
                className="text-ui-fg-error break-words"
              >
                {error || documentFailure}
              </Text>
            )}
          </div>
        )}
      </div>

      {!isCanceled && (
        <div className="px-6 py-4 border-b border-ui-border-base">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {!awb && shiprocketFulfillment.data?.shiprocket_deferred_awb && (
                <Button size="small" onClick={assignAwb} disabled={assigning}>
                  {assigning ? "Assigning AWB…" : "Assign AWB"}
                </Button>
              )}
              {awb && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={schedulePickup}
                  disabled={scheduling || syncing || !!isScheduled}
                >
                  {scheduling
                    ? "Scheduling…"
                    : isScheduled
                      ? "Pickup scheduled"
                      : "Schedule pickup"}
                </Button>
              )}
              {awb &&
                (!labelUrl ||
                  documentFailure ||
                  (isScheduled && !manifestUrl)) && (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={syncTracking}
                    disabled={syncing || scheduling || assigning}
                  >
                    {syncing
                      ? "Generating documents…"
                      : documentFailure
                        ? "Retry documents"
                        : "Generate documents"}
                  </Button>
                )}
            </div>
            <Button
              variant="danger"
              size="small"
              onClick={cancelShipment}
              disabled={canceling || syncing}
            >
              {canceling ? "Canceling…" : "Cancel"}
            </Button>
          </div>
          {!awb && (
            <Text size="xsmall" className="mt-2 text-ui-fg-subtle">
              Assign an AWB first, then schedule pickup when the parcel is
              ready.
            </Text>
          )}
        </div>
      )}

      {/* Documents Grid */}
      <div className="px-6 py-4 border-b border-ui-border-base bg-ui-bg-base">
        <Text size="xsmall" className="text-ui-fg-subtle mb-3 block">
          Documents
        </Text>

        <div className="flex flex-wrap gap-2">
          <DocumentButton
            href={labelUrl}
            label="Label"
            status={documentStatus?.label}
            icon={<DocumentText className="w-5 h-5 text-ui-tag-blue-icon" />}
            bg="bg-ui-tag-blue-bg"
            hoverBorder="hover:border-ui-tag-blue-border"
          />
          <DocumentButton
            href={invoiceUrl}
            label="Invoice"
            status={documentStatus?.invoice}
            icon={<SquareTwoStack className="w-5 h-5 text-ui-tag-green-icon" />}
            bg="bg-ui-tag-green-bg"
            hoverBorder="hover:border-ui-tag-green-border"
          />
          <DocumentButton
            href={manifestUrl}
            label="Manifest"
            status={documentStatus?.manifest}
            icon={<ListBullet className="w-5 h-5 text-ui-tag-orange-icon" />}
            bg="bg-ui-tag-orange-bg"
            hoverBorder="hover:border-ui-tag-orange-border"
          />
        </div>
      </div>

      {/* Timeline */}
      {tracking?.scans && tracking.scans.length > 0 && (
        <div className="bg-ui-bg-subtle/50 p-6 border-b border-ui-border-base">
          <div className="flex items-center justify-between mb-6">
            <Text
              size="xsmall"
              className="text-ui-fg-muted font-bold uppercase tracking-[0.1em] text-[10px]"
            >
              Tracking Timeline
            </Text>
            {tracking.etd && (
              <div className="flex items-center gap-x-1.5">
                <Text size="xsmall" className="text-ui-fg-muted">
                  Est. Delivery:
                </Text>
                <Badge color="green" size="xsmall" className="font-bold">
                  {new Date(tracking.etd).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </Badge>
              </div>
            )}
          </div>

          <div className="space-y-0 relative">
            {(tracking.scans as any[])
              .slice()
              .reverse()
              .map((scan, index, arr) => (
                <div key={index} className="flex gap-x-5 group">
                  <div className="relative flex flex-col items-center shrink-0">
                    <div
                      className={`z-10 flex h-5 w-5 shrink-0 mt-0.5 items-center justify-center rounded-full border-2 bg-ui-bg-base transition-all ${index === 0 ? "border-ui-fg-interactive ring-4 ring-ui-tag-blue-bg scale-110 shadow-sm" : "border-ui-border-base group-hover:border-ui-border-strong"}`}
                    >
                      <div
                        className={`h-2 w-2 rounded-full ${index === 0 ? "bg-ui-fg-interactive animate-pulse" : "bg-ui-fg-muted group-hover:bg-ui-fg-base"}`}
                      />
                    </div>
                    {index !== arr.length - 1 && (
                      <div className="absolute top-5 h-full w-[2px] bg-ui-border-base group-hover:bg-ui-border-strong transition-colors" />
                    )}
                  </div>
                  <div className="pb-10 pt-0 group-last:pb-2">
                    <div className="flex flex-col gap-y-1.5">
                      <Text
                        size="small"
                        weight="plus"
                        className={`leading-tight uppercase tracking-tight ${index === 0 ? "text-ui-fg-base font-bold" : "text-ui-fg-subtle"}`}
                      >
                        {humanizeStatus(
                          scan.activity || scan.status || "Status Update"
                        )}
                      </Text>
                      <div className="flex items-center gap-x-3 text-ui-fg-muted font-medium">
                        <div className="flex items-center gap-x-1 text-[11px] whitespace-nowrap bg-ui-bg-component px-1.5 py-0.5 rounded border border-ui-border-base">
                          <span>📅</span>{" "}
                          {scan.date
                            ? new Date(scan.date).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "N/A"}
                        </div>
                        {scan.location && scan.location !== "NA" && (
                          <div className="flex items-center gap-x-1 text-[11px] font-bold text-ui-fg-interactive">
                            <span>📍</span> {scan.location}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* External Tracking Footer */}
      {trackingUrl && !isCanceled && (
        <div className="px-6 py-4 bg-ui-bg-base">
          <Button
            variant="primary"
            size="small"
            className=""
            onClick={() =>
              window.open(trackingUrl, "_blank", "noopener,noreferrer")
            }
          >
            <span>Track Shipment</span>
            <ArrowUpRightOnBox className="w-4 h-4 ml-1.5" />
          </Button>
        </div>
      )}
    </Container>
  )
}

const DocumentButton = ({
  href,
  label,
  icon,
  bg,
  hoverBorder,
  status,
}: {
  href?: string
  label: string
  icon: React.ReactNode
  bg: string
  hoverBorder: string
  status?: { available: boolean; message: string }
}) => {
  const isAvailable =
    !!href && href.startsWith("https://") && status?.available !== false
  const safeHref = isAvailable ? href : "#"
  return (
    <a
      href={safeHref}
      aria-disabled={!isAvailable}
      tabIndex={isAvailable ? 0 : -1}
      title={status?.message}
      target={isAvailable ? "_blank" : undefined}
      rel={isAvailable ? "noopener noreferrer" : undefined}
      className={`inline-flex min-w-[120px] items-center gap-x-2 py-2 px-3 rounded-md border transition-colors group ${
        isAvailable
          ? `border-ui-border-base bg-ui-bg-base ${hoverBorder} hover:shadow-elevation-card-hover`
          : "border-ui-border-base bg-ui-bg-subtle cursor-not-allowed"
      }`}
      onClick={(e) => !isAvailable && e.preventDefault()}
    >
      <div
        className={`flex shrink-0 items-center justify-center w-6 h-6 rounded-md ${isAvailable ? bg : "bg-ui-bg-component"}`}
      >
        <div className="w-3.5 h-3.5 flex items-center justify-center">
          {icon}
        </div>
      </div>
      <Text
        size="xsmall"
        weight="plus"
        className={isAvailable ? "text-ui-fg-base" : "text-ui-fg-muted"}
      >
        {label}
      </Text>
    </a>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details",
})

export default ShiprocketDocumentsWidget
