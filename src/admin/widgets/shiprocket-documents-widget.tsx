import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Badge, Text, Copy, Button } from "@medusajs/ui"
import { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { useState, useEffect } from "react"
import { ArrowPath, DocumentText, SquareTwoStack, ListBullet, ArrowUpRightOnBox } from "@medusajs/icons"
// @ts-ignore
import logo from "../../assets/logo.png"

/**
 * Shiprocket Documents Widget
 * 
 * Displays shipment documents and tracking links for easy access.
 * Shows: AWB, Tracking URL, Label, Invoice, and Manifest downloads.
 */
const ShiprocketDocumentsWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
    // Defines extended fulfillment type to include labels
    type ShiprocketFulfillment = NonNullable<AdminOrder['fulfillments']>[number] & {
        labels?: Array<{
            tracking_number?: string
            tracking_url?: string
            label_url?: string
        }>
    }

    const fulfillments = data?.fulfillments || []

    // Find Shiprocket fulfillment - Medusa v2 formats provider_id as "fp_{module}_{identifier}"
    // e.g. "fp_shiprocket_shiprocket", so we check with includes() for robustness
    const shiprocketFulfillment = fulfillments.find(f =>
        f.provider_id?.toLowerCase().includes("shiprocket") ||
        f.data?.courier_name // fallback: has Shiprocket courier data
    ) as ShiprocketFulfillment | undefined

    // Widget State
    const [tracking, setTracking] = useState<any | null>(null)
    const [loading, setLoading] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [scheduling, setScheduling] = useState(false)
    const [canceling, setCanceling] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [fetchedDocs, setFetchedDocs] = useState<any>(null)

    // Extract basic info from fulfillment
    const label = shiprocketFulfillment?.labels?.[0]
    const awb = (label?.tracking_number || shiprocketFulfillment?.data?.awb) as string

    // Document URLs (Prioritize fetched, then props)
    const labelUrl = (fetchedDocs?.label_url || label?.label_url || shiprocketFulfillment?.data?.label_url) as string
    const invoiceUrl = (fetchedDocs?.invoice_url || shiprocketFulfillment?.data?.invoice_url) as string
    const manifestUrl = (fetchedDocs?.manifest_url || shiprocketFulfillment?.data?.manifest_url) as string

    const trackingUrl = (label?.tracking_url ||
        (awb ? `https://shiprocket.co/tracking/${encodeURIComponent(awb)}` : null)) as string
    const courierName = shiprocketFulfillment?.data?.courier_name as string

    // Fetch tracking on mount if AWB is present
    useEffect(() => {
        if (!awb) return

        setLoading(true)
        fetch(`/admin/shiprocket/tracking/${encodeURIComponent(awb)}`, { credentials: "include" })
            .then(res => {
                if (res.status === 404) return null
                return res.json()
            })
            .then(result => {
                if (result?.success && result.tracking) {
                    setTracking(result.tracking)
                }
            })
            .catch(() => { /* silent fail for initial load */ })
            .finally(() => setLoading(false))
    }, [awb])

    const syncTracking = async () => {
        if (!awb || syncing) return
        setSyncing(true)
        setError(null)

        try {
            const response = await fetch(`/admin/shiprocket/tracking/${encodeURIComponent(awb)}/sync`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    fulfillment_id: shiprocketFulfillment?.id
                }),
                credentials: "include",
            })
            const result = await response.json()

            if (result.success) {
                // Update documents if returned
                if (result.documents) {
                    setFetchedDocs(result.documents)
                }

                // Refresh tracking
                const trackRes = await fetch(`/admin/shiprocket/tracking/${encodeURIComponent(awb)}`, { credentials: "include" })
                const trackData = await trackRes.json()
                if (trackData?.success && trackData.tracking) {
                    setTracking(trackData.tracking)
                }
            } else {
                setError(result.error || "Sync failed")
            }
        } catch (err) {
            setError("Failed to sync tracking")
        } finally {
            setSyncing(false)
        }
    }

    const schedulePickup = async () => {
        if (!awb || scheduling) return
        setScheduling(true)
        setError(null)

        try {
            const response = await fetch(`/admin/shiprocket/tracking/${encodeURIComponent(awb)}/pickup`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fulfillment_id: shiprocketFulfillment?.id }),
                credentials: "include",
            })
            const result = await response.json()

            if (result.success || response.ok) {
                // optionally sync tracking afterwards to get updated status
                syncTracking()
            } else {
                setError(result.error || "Failed to schedule pickup")
            }
        } catch (err) {
            setError("Failed to schedule pickup")
        } finally {
            setScheduling(false)
        }
    }

    const cancelShipment = async () => {
        if (!shiprocketFulfillment?.id || canceling) return
        if (!confirm("Are you sure you want to cancel this entire shipment? This action cannot be undone and will void the AWB.")) return
        
        setCanceling(true)
        setError(null)

        try {
            const response = await fetch(`/admin/fulfillments/${shiprocketFulfillment.id}/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
            })

            if (response.ok) {
                syncTracking()
            } else {
                const result = await response.json()
                setError(result.message || "Failed to cancel shipment")
            }
        } catch (err) {
            setError("Failed to cancel shipment")
        } finally {
            setCanceling(false)
        }
    }

    const humanizeStatus = (text: string) => {
        if (!text) return ""
        const s = text.toUpperCase()

        // Common Shiprocket merged statuses mapping
        const validStatuses: Record<string, string> = {
            "READYFORRECEIVE": "Ready For Receive",
            "PICKUPCANCELLED": "Pickup Cancelled",
            "OUTFORPICKUP": "Out For Pickup",
            "PICKUPGENERATED": "Pickup Generated",
            "PICKUPSCHEDULED": "Pickup Scheduled",
            "PICKUPQUEUED": "Pickup Queued",
            "PICKUPRESCHEDULED": "Pickup Rescheduled",
            "PICKUPPICKEDUP": "Pickup Picked Up",
            "AWBASSIGNED": "AWB Assigned",
            "LABELGENERATED": "Label Generated",
            "MANIFESTGENERATED": "Manifest Generated",
            "INTRANSIT": "In Transit",
            "OUTFORDELIVERY": "Out For Delivery",
            "DELIVERED": "Delivered",
            "CANCELLED": "Cancelled",
            "RTOINITIATED": "RTO Initiated",
            "RTODELIVERED": "RTO Delivered",
            "RTOACKNOWLEDGED": "RTO Acknowledged",
            "LOST": "Lost",
            "DAMAGED": "Damaged",
            "DESTROYED": "Destroyed",
            "DISPOSEOFF": "Dispose Off"
        }

        if (validStatuses[s]) return validStatuses[s]

        // Fallback: Title Case replacing underscores/dashes, handling simple spacing if possible
        return text
            .replace(/([A-Z])/g, ' $1') // simple space insertion if camelCase (unlikely here but safe)
            .replace(/[_-]/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ')
    }

    const getStatusColor = (status: string) => {
        const s = status?.toUpperCase() || ""
        if (s.includes("DELIVER")) return "green"
        if (s.includes("TRANSIT") || s.includes("SHIPPED")) return "blue"
        if (s.includes("PICKUP") || s.includes("PICKED")) return "purple"
        if (s.includes("RTO") || s.includes("RETURN")) return "orange"
        if (s.includes("CANCEL") || s.includes("ERROR") || s.includes("EXCEPTION")) return "red"
        return "grey"
    }

    if (!shiprocketFulfillment) return null

    // Determine the most relevant status to show
    let displayStatus = tracking?.current_status || ""

    // If we have scans, check if the latest scan is more critical/current than the top-level status
    // (e.g., if top is "AWB ASSIGNED" but latest scan is "PICKUP CANCELLED")
    if (tracking?.scans?.length > 0) {
        const latestScan = tracking.scans[tracking.scans.length - 1] // Last item is usually latest in Shiprocket array, check mapping below
        // The API array might vary, but we reversed it in the map previously using slice().reverse(). 
        // Let's assume 'scans' is chronological. In the UI map we slice().reverse(), so array is [oldest, ..., newest].
        // Wait, normally API returns chronological. The UI map was `.slice().reverse()`, implying the last element in raw data is the newest.
        const latestActivity = latestScan.activity || latestScan.status || ""

        // If the latest activity implies a terminal or critical state, override generic "AWB ASSIGNED"
        if (latestActivity.toUpperCase().includes("CANCELLED") ||
            latestActivity.toUpperCase().includes("DELIVERED") ||
            latestActivity.toUpperCase().includes("RTO")) {
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
    const isScheduled = tracking?.scans?.some((s: any) => s.activity?.toUpperCase().includes("SCHEDULED") || s.status?.toUpperCase().includes("SCHEDULED")) || tracking?.pickup_scheduled_date

    return (
        <Container className="p-0 overflow-hidden border border-ui-border-base bg-ui-bg-base/50 shadow-elevation-card-rest">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base bg-white dark:bg-ui-bg-base">
                <div className="flex items-center gap-x-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-ui-border-base bg-white dark:bg-ui-bg-base shadow-sm overflow-hidden p-1.5">
                        <img
                            src={logo}
                            alt="Shiprocket"
                            className="h-full w-full object-contain mix-blend-multiply dark:mix-blend-normal"
                        />
                    </div>
                    <div>
                        <Heading level="h2" className="text-sm font-bold text-ui-fg-base leading-none mb-1">Shipment & Tracking</Heading>
                        <Text size="xsmall" className="text-ui-fg-muted font-medium">{tracking?.courier_name || courierName || "Shiprocket Fulfillment"}</Text>
                    </div>
                </div>
                {humanStatus && (
                    <Badge color={getStatusColor(humanStatus)} size="xsmall" className="font-bold px-3 py-1 rounded-full uppercase tracking-tighter text-[10px]">
                        {humanStatus}
                    </Badge>
                )}
            </div>

            {/* Tracking ID & Sync */}
            <div className="px-6 py-5 border-b border-ui-border-base bg-ui-bg-subtle">
                <div className="flex items-center justify-between">
                    <div>
                        <Text size="xsmall" className="text-ui-fg-muted font-bold uppercase tracking-[0.1em] text-[10px] mb-1 block">AWB Number</Text>
                        <div className="flex items-center gap-x-2">
                            <Text className="text-xl font-mono font-bold tracking-tight text-ui-fg-base leading-none">{awb || "UNASSIGNED"}</Text>
                            {awb && <Copy content={awb} className="text-ui-fg-muted transition-colors hover:text-ui-fg-base" />}
                        </div>
                    </div>
                    {awb && (
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={syncTracking}
                            disabled={syncing}
                            className="bg-ui-bg-base hover:bg-ui-bg-subtle h-8 w-8 p-0 border-ui-border-strong shadow-sm group"
                        >
                            <ArrowPath className={`w-3.5 h-3.5 ${syncing ? 'animate-spin text-ui-fg-interactive' : 'text-ui-fg-subtle group-hover:text-ui-fg-base'}`} />
                        </Button>
                    )}
                </div>

                {/* Shipment Specs */}
                {(tracking?.weight || tracking?.origin) && (
                    <div className="flex items-center gap-x-4 pt-3">
                        {tracking.weight && (
                            <div className="flex items-center gap-x-1.5 px-2 py-0.5 rounded bg-ui-bg-component border border-ui-border-base shadow-sm">
                                <Text size="xsmall" className="text-ui-fg-muted">⚖️</Text>
                                <Text size="xsmall" weight="plus" className="text-ui-fg-base">{tracking.weight} kg</Text>
                            </div>
                        )}
                        {tracking.origin && (
                            <div className="flex items-center gap-x-1.5">
                                <Text size="xsmall" className="text-ui-fg-muted">📍</Text>
                                <Text size="xsmall" weight="plus" className="text-ui-fg-base whitespace-nowrap">{tracking.origin} <span className="text-ui-fg-muted mx-0.5">→</span> {tracking.destination || "Dest"}</Text>
                            </div>
                        )}
                    </div>
                )}

                {/* Sync info & Error */}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-ui-border-base/50">
                    <Text size="xsmall" className="text-ui-fg-muted font-medium">
                        {tracking?.updated_at ? `Updated: ${new Date(tracking.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : "Not Synced"}
                    </Text>
                    {error && (
                        <Text size="xsmall" className="text-ui-fg-error font-medium max-w-[200px] truncate">
                            {error}
                        </Text>
                    )}
                </div>
            </div>

            {/* Action Buttons Row */}
            {awb && !isCanceled && (
                <div className="px-6 py-4 border-b border-ui-border-base bg-ui-bg-base/30 grid grid-cols-2 gap-3">
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={schedulePickup}
                        disabled={scheduling || syncing}
                        className="w-full bg-ui-bg-base hover:bg-ui-bg-subtle h-9 text-xs font-bold border-ui-border-strong shadow-sm"
                    >
                        {scheduling ? "Scheduling..." : (isScheduled ? "Reschedule" : "Schedule")}
                    </Button>
                    <Button
                        variant="danger"
                        size="small"
                        onClick={cancelShipment}
                        disabled={canceling || syncing}
                        className="w-full h-9 text-xs font-bold shadow-sm"
                    >
                        {canceling ? "Canceling..." : "Cancel"}
                    </Button>
                </div>
            )}

            {/* Documents Grid */}
            <div className="px-6 py-6 border-b border-ui-border-base bg-ui-bg-base">
                <Text size="xsmall" className="text-ui-fg-muted font-bold uppercase tracking-[0.1em] text-[10px] mb-5 block">Logistics Documents</Text>

                <div className="grid grid-cols-3 gap-x-4">
                    <DocumentButton
                        href={labelUrl}
                        label="Label"
                        icon={<DocumentText className="w-5 h-5 text-ui-tag-blue-icon" />}
                        bg="bg-ui-tag-blue-bg"
                        hoverBorder="hover:border-ui-tag-blue-border"
                    />
                    <DocumentButton
                        href={invoiceUrl}
                        label="Invoice"
                        icon={<SquareTwoStack className="w-5 h-5 text-ui-tag-green-icon" />}
                        bg="bg-ui-tag-green-bg"
                        hoverBorder="hover:border-ui-tag-green-border"
                    />
                    <DocumentButton
                        href={manifestUrl}
                        label="Manifest"
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
                        <Text size="xsmall" className="text-ui-fg-muted font-bold uppercase tracking-[0.1em] text-[10px]">Tracking Timeline</Text>
                        {tracking.etd && (
                            <div className="flex items-center gap-x-1.5">
                                <Text size="xsmall" className="text-ui-fg-muted">Est. Delivery:</Text>
                                <Badge color="green" size="xsmall" className="font-bold">{new Date(tracking.etd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Badge>
                            </div>
                        )}
                    </div>

                    <div className="space-y-0 relative">
                        {(tracking.scans as any[]).slice().reverse().map((scan, index, arr) => (
                            <div key={index} className="flex gap-x-5 group">
                                <div className="relative flex flex-col items-center shrink-0">
                                    <div className={`z-10 flex h-5 w-5 shrink-0 mt-0.5 items-center justify-center rounded-full border-2 bg-ui-bg-base transition-all ${index === 0 ? 'border-ui-fg-interactive ring-4 ring-ui-tag-blue-bg scale-110 shadow-sm' : 'border-ui-border-base group-hover:border-ui-border-strong'}`}>
                                        <div className={`h-2 w-2 rounded-full ${index === 0 ? 'bg-ui-fg-interactive animate-pulse' : 'bg-ui-fg-muted group-hover:bg-ui-fg-base'}`} />
                                    </div>
                                    {index !== arr.length - 1 && (
                                        <div className="absolute top-5 h-full w-[2px] bg-ui-border-base group-hover:bg-ui-border-strong transition-colors" />
                                    )}
                                </div>
                                <div className="pb-10 pt-0 group-last:pb-2">
                                    <div className="flex flex-col gap-y-1.5">
                                        <Text size="small" weight="plus" className={`leading-tight uppercase tracking-tight ${index === 0 ? 'text-ui-fg-base font-bold' : 'text-ui-fg-subtle'}`}>
                                            {humanizeStatus(scan.activity || scan.status || "Status Update")}
                                        </Text>
                                        <div className="flex items-center gap-x-3 text-ui-fg-muted font-medium">
                                            <div className="flex items-center gap-x-1 text-[11px] whitespace-nowrap bg-ui-bg-component px-1.5 py-0.5 rounded border border-ui-border-base">
                                                <span>📅</span> {scan.date ? new Date(scan.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'}
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
                <div className="p-5 bg-ui-bg-base border-t border-ui-border-base">
                    <Button
                        variant="primary"
                        size="small"
                        className="w-full h-9 font-bold"
                        onClick={() => window.open(trackingUrl, "_blank", "noopener,noreferrer")}
                    >
                        <span>Track Shipment</span>
                        <ArrowUpRightOnBox className="w-4 h-4 ml-1.5" />
                    </Button>
                </div>
            )}
        </Container>
    )
}

const DocumentButton = ({ href, label, icon, bg, hoverBorder }: { href?: string, label: string, icon: React.ReactNode, bg: string, hoverBorder: string }) => {
    const isAvailable = !!href && href.startsWith("https://")
    const safeHref = isAvailable ? href : "#"
    return (
        <a
            href={safeHref}
            target={isAvailable ? "_blank" : undefined}
            rel={isAvailable ? "noopener noreferrer" : undefined}
            className={`flex items-center justify-center gap-x-2 py-2 px-3 rounded-lg border transition-all duration-300 group w-full ${isAvailable
                ? `border-ui-border-base bg-ui-bg-base ${hoverBorder} hover:shadow-elevation-card-hover hover:-translate-y-0.5`
                : "border-dashed border-ui-border-base bg-ui-bg-subtle/50 cursor-not-allowed grayscale opacity-50"
                }`}
            onClick={(e) => !isAvailable && e.preventDefault()}
        >
            <div className={`flex items-center justify-center w-6 h-6 rounded-md transition-transform duration-300 group-hover:scale-110 shadow-sm ${isAvailable ? bg : "bg-ui-bg-component"}`}>
                <div className="w-3.5 h-3.5 flex items-center justify-center">{icon}</div>
            </div>
            <Text size="xsmall" weight="plus" className={`uppercase tracking-wider text-[10px] font-bold ${isAvailable ? "text-ui-fg-base" : "text-ui-fg-muted"}`}>{label}</Text>
        </a>
    )
}

export const config = defineWidgetConfig({
    zone: "order.details.side.before",
})

export default ShiprocketDocumentsWidget
