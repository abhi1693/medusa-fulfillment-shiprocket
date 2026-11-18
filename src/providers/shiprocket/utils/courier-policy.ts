export class CourierQuoteError extends Error {}
export type CourierPolicy = {
  selection: "lowest_price" | "highest_rating"
  fallback?: "none" | "relax_preferences"
  preferred_real_time_tracking?: boolean
  preferred_pod?: "any" | "instant" | "on_request"
  preferred_call_before_delivery?: boolean
  require_real_time_tracking: boolean
  pod: "any" | "instant" | "on_request"
  require_call_before_delivery: boolean
}
export type CourierPolicyOptions = {
  courier_selection?: string
  courier_fallback?: string
  preferred_real_time_tracking?: boolean
  preferred_pod?: string
  preferred_call_before_delivery?: boolean
  require_real_time_tracking?: boolean
  pod_requirement?: string
  require_call_before_delivery?: boolean
}
export function courierPolicy(
  options: CourierPolicyOptions = {}
): CourierPolicy {
  const selection = options.courier_selection ?? "lowest_price"
  const pod = options.pod_requirement ?? "any"
  if (!["lowest_price", "highest_rating"].includes(selection))
    throw Error(
      "SHIPROCKET_COURIER_SELECTION must be lowest_price or highest_rating"
    )
  if (!["any", "instant", "on_request"].includes(pod))
    throw Error("SHIPROCKET_POD_REQUIREMENT must be any, instant or on_request")
  function flag(value: boolean | undefined, key: string): boolean {
    if (value !== undefined) {
      if (typeof value !== "boolean")
        throw Error(key + " must be true or false")
      return value
    }
    return false
  }
  const fallback = options.courier_fallback ?? "relax_preferences"
  const preferredPod = options.preferred_pod ?? "any"
  if (!["none", "relax_preferences"].includes(fallback))
    throw Error("SHIPROCKET_COURIER_FALLBACK must be none or relax_preferences")
  if (!["any", "instant", "on_request"].includes(preferredPod))
    throw Error("SHIPROCKET_PREFERRED_POD must be any, instant or on_request")
  return {
    selection: selection as CourierPolicy["selection"],
    fallback: fallback as CourierPolicy["fallback"],
    preferred_real_time_tracking: flag(
      options.preferred_real_time_tracking,
      "SHIPROCKET_PREFERRED_REAL_TIME_TRACKING"
    ),
    preferred_pod: preferredPod as CourierPolicy["preferred_pod"],
    preferred_call_before_delivery: flag(
      options.preferred_call_before_delivery,
      "SHIPROCKET_PREFERRED_CALL_BEFORE_DELIVERY"
    ),
    pod: pod as CourierPolicy["pod"],
    require_real_time_tracking: flag(
      options.require_real_time_tracking,
      "SHIPROCKET_REQUIRE_REAL_TIME_TRACKING"
    ),
    require_call_before_delivery: flag(
      options.require_call_before_delivery,
      "SHIPROCKET_REQUIRE_CALL_BEFORE_DELIVERY"
    ),
  }
}
export type CourierQuote = {
  parcel_plan?: import("../../../shared/packed-unit-plan").PackedUnitPlan
  shipment_allocation?: import("../../../shared/cart-shipment-plan").ShipmentAllocation
  courier_company_id: number
  courier_name: string
  amount: number
  service: "air" | "surface" | null
  origin_location_id?: string
  origin_location_name?: string | null
  quote_token?: string
  expires_at?: string
  rating: number | null
  estimated_delivery_days: string | null
  estimated_delivery_date: string | null
  realtime_tracking: boolean | null
  pod: "instant" | "on_request" | null
  call_before_delivery: boolean | null
  policy: CourierPolicy
  relaxed_preferences: string[]
  quoted_at: string
}
function numeric(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    String(value).trim() === ""
  )
    return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}
function deliveryDays(value: string): string | null {
  if (!/^(?:0|[1-9]\d*)(?:\s*-\s*(?:0|[1-9]\d*))?$/.test(value)) return null
  const parts = value.split(/\s*-\s*/).map(Number)
  if (
    parts.some((n) => !Number.isSafeInteger(n)) ||
    (parts.length === 2 && parts[1] < parts[0])
  )
    return null
  return value
}
export function courierQuote(
  row: any,
  policy: CourierPolicy
): CourierQuote | null {
  const id = numeric(row.courier_company_id),
    amount = numeric(row.rate),
    score = numeric(row.rating)
  if (
    id === null ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    amount === null ||
    amount <= 0 ||
    typeof row.courier_name !== "string" ||
    !row.courier_name.trim()
  )
    return null
  const tracking = text(row.realtime_tracking)
  const call = text(row.call_before_delivery)
  const pod = text(row.pod_available)
  const days =
    typeof row.estimated_delivery_days === "number"
      ? String(row.estimated_delivery_days)
      : typeof row.estimated_delivery_days === "string"
        ? row.estimated_delivery_days.trim()
        : ""
  const date = typeof row.etd === "string" ? row.etd.trim() : ""
  // Only documented affirmative capability labels pass enabled filters. Unknown
  // and absent data are not inferred from tracking status or contact details.
  return {
    courier_company_id: id,
    courier_name: row.courier_name.trim(),
    amount,
    service:
      row.is_surface === true
        ? "surface"
        : row.is_surface === false
          ? "air"
          : null,
    rating: score !== null && score >= 0 && score <= 5 ? score : null,
    estimated_delivery_days: deliveryDays(days),
    estimated_delivery_date:
      date && Number.isFinite(Date.parse(date)) ? date : null,
    realtime_tracking:
      tracking === "real time"
        ? true
        : ["not available", "mis"].includes(tracking)
          ? false
          : null,
    pod:
      pod === "instant"
        ? "instant"
        : pod === "on request"
          ? "on_request"
          : null,
    call_before_delivery:
      call === "available" ? true : call === "not available" ? false : null,
    policy,
    relaxed_preferences: [],
    quoted_at: new Date().toISOString(),
  }
}
export function selectCourier(
  rows: any[],
  policy: CourierPolicy,
  allowed?: number[],
  selectedId?: number
): CourierQuote {
  const eligible = rows
    .map((row) => courierQuote(row, policy))
    .filter(
      (q): q is CourierQuote =>
        !!q &&
        (!allowed?.length || allowed.includes(q.courier_company_id)) &&
        (!policy.require_real_time_tracking || q.realtime_tracking === true) &&
        (!policy.require_call_before_delivery ||
          q.call_before_delivery === true) &&
        (policy.pod === "any" || q.pod === policy.pod) &&
        (policy.selection !== "highest_rating" || q.rating !== null)
    )
  // Preferences relax in this fixed order. Hard requirements above never do.
  const preferences: { name: string; accept: (q: CourierQuote) => boolean }[] =
    []
  if (policy.preferred_call_before_delivery)
    preferences.push({
      name: "call_before_delivery",
      accept: (q) => q.call_before_delivery === true,
    })
  if (policy.preferred_pod && policy.preferred_pod !== "any")
    preferences.push({
      name: "pod",
      accept: (q) => q.pod === policy.preferred_pod,
    })
  if (policy.preferred_real_time_tracking)
    preferences.push({
      name: "real_time_tracking",
      accept: (q) => q.realtime_tracking === true,
    })
  if (selectedId !== undefined) {
    const selected = eligible.find((q) => q.courier_company_id === selectedId)
    if (!selected)
      throw new CourierQuoteError(
        "Selected Shiprocket courier is no longer eligible; review shipping again"
      )
    const missing = preferences
      .filter((p) => !p.accept(selected))
      .map((p) => p.name)
    if (missing.length && policy.fallback === "none")
      throw new CourierQuoteError(
        "Selected Shiprocket courier no longer meets courier preferences; review shipping again"
      )
    return { ...selected, relaxed_preferences: missing }
  }
  const relaxed: string[] = []
  for (let offset = 0; offset <= preferences.length; offset++) {
    const candidates = eligible.filter((q) =>
      preferences.slice(offset).every((p) => p.accept(q))
    )
    candidates.sort(
      (a, b) =>
        (policy.selection === "highest_rating" ? b.rating! - a.rating! : 0) ||
        a.amount - b.amount ||
        a.courier_company_id - b.courier_company_id
    )
    if (candidates.length)
      return { ...candidates[0], relaxed_preferences: [...relaxed] }
    if (policy.fallback === "none" || offset === preferences.length) break
    relaxed.push(preferences[offset].name)
  }
  throw new CourierQuoteError(
    "No Shiprocket courier meets the configured prepaid courier requirements"
  )
}
export function assertMatchingCourier(
  expected: unknown,
  actual: CourierQuote
): void {
  if (expected == null) return
  if (
    typeof expected !== "object" ||
    Number((expected as any).courier_company_id) !==
      actual.courier_company_id ||
    Number((expected as any).amount) !== actual.amount ||
    ((expected as any).service !== undefined &&
      (expected as any).service !== actual.service)
  )
    throw new CourierQuoteError(
      "Shiprocket courier or price changed; refresh delivery options and select again"
    )
}

export function courierChoices(
  rows: any[],
  policy: CourierPolicy,
  allowed?: number[]
): CourierQuote[] {
  const result: CourierQuote[] = []
  for (const surface of [false, true]) {
    let remaining = rows.filter((row) => row.is_surface === surface)
    for (let index = 0; index < 1; index++) {
      let quote: CourierQuote
      try {
        quote = selectCourier(remaining, policy, allowed)
      } catch (error) {
        if (error instanceof CourierQuoteError) break
        throw error
      }
      result.push(quote)
      remaining = remaining.filter(
        (row) => Number(row.courier_company_id) !== quote.courier_company_id
      )
    }
  }
  if (!result.length)
    throw new CourierQuoteError(
      "No eligible Shiprocket air or surface courier is available"
    )
  return result
}

/** Allowlisted decision evidence; never serialize raw carrier responses. */
export function courierDecisionRows(
  rows: any[],
  policy: CourierPolicy,
  allowed?: number[],
  selected: CourierQuote[] = [],
  requireKnownService = true
) {
  return rows.map((row) => {
    const q = courierQuote(row, policy)
    if (!q) return { status: "rejected", reasons: ["invalid_identity_or_rate"] }
    const reasons: string[] = []
    if (requireKnownService && q.service === null)
      reasons.push("unknown_service")
    if (allowed?.length && !allowed.includes(q.courier_company_id))
      reasons.push("not_in_allowed_couriers")
    if (policy.require_real_time_tracking && q.realtime_tracking !== true)
      reasons.push("real_time_tracking_required")
    if (policy.require_call_before_delivery && q.call_before_delivery !== true)
      reasons.push("call_before_delivery_required")
    if (policy.pod !== "any" && q.pod !== policy.pod)
      reasons.push("pod_requirement")
    if (policy.selection === "highest_rating" && q.rating === null)
      reasons.push("rating_missing")
    const winner = selected.find(
      (choice) =>
        choice.courier_company_id === q.courier_company_id &&
        choice.service === q.service
    )
    return {
      courier_id: q.courier_company_id,
      service: q.service,
      carrier_amount_inr: q.amount,
      rating: q.rating,
      realtime_tracking: q.realtime_tracking,
      pod: q.pod,
      call_before_delivery: q.call_before_delivery,
      status: reasons.length
        ? "rejected"
        : winner
          ? "selected"
          : "eligible_not_selected",
      reasons,
      unmet_preferences: [
        ...(policy.preferred_call_before_delivery &&
        q.call_before_delivery !== true
          ? ["call_before_delivery"]
          : []),
        ...(policy.preferred_pod &&
        policy.preferred_pod !== "any" &&
        q.pod !== policy.preferred_pod
          ? ["pod"]
          : []),
        ...(policy.preferred_real_time_tracking && q.realtime_tracking !== true
          ? ["real_time_tracking"]
          : []),
      ],
      ...(winner ? { relaxed_preferences: winner.relaxed_preferences } : {}),
    }
  })
}
