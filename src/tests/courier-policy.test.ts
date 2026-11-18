import test from "node:test"
import assert from "node:assert/strict"
import {
  courierPolicy,
  selectCourier,
  courierChoices,
  assertMatchingCourier,
} from "../providers/shiprocket/utils/courier-policy"
const low = {
  courier_company_id: 2,
  courier_name: "Cheap",
  rate: 50,
  rating: 4,
  estimated_delivery_days: "4",
  realtime_tracking: "Real Time",
  pod_available: "Instant",
  call_before_delivery: "Available",
}
const high = {
  ...low,
  courier_company_id: 1,
  courier_name: "Rated",
  rate: 80,
  rating: 4.9,
  estimated_delivery_days: "2",
}
const policy = (changes: any = {}) => ({
  selection: "lowest_price" as const,
  require_real_time_tracking: false,
  pod: "any" as const,
  require_call_before_delivery: false,
  ...changes,
})
test("default ranking remains price; highest rating carries the same courier's price and ETA", () => {
  assert.equal(courierPolicy().selection, "lowest_price")
  assert.equal(selectCourier([high, low], policy()).amount, 50)
  const quote = selectCourier(
    [low, high],
    policy({ selection: "highest_rating" })
  )
  assert.equal(quote.courier_company_id, 1)
  assert.equal(quote.amount, 80)
  assert.equal(quote.estimated_delivery_days, "2")
})
test("highest rating excludes unknown and invalid scores, with deterministic price/id tie breaks", () => {
  for (const rating of [undefined, null, "", NaN, -1, 6])
    assert.throws(
      () =>
        selectCourier(
          [{ ...low, rating }],
          policy({ selection: "highest_rating" })
        ),
      /No Shiprocket courier/
    )
  assert.equal(
    selectCourier(
      [high, { ...low, rating: 4.9 }],
      policy({ selection: "highest_rating" })
    ).courier_company_id,
    2
  )
  assert.equal(
    selectCourier([{ ...low, courier_company_id: 3 }, low], policy())
      .courier_company_id,
    2
  )
})
test("capability filters require documented positive values and never infer from unrelated fields", () => {
  for (const field of [
    "realtime_tracking",
    "pod_available",
    "call_before_delivery",
  ]) {
    const filter =
      field === "realtime_tracking"
        ? { require_real_time_tracking: true }
        : field === "pod_available"
          ? { pod: "instant" }
          : { require_call_before_delivery: true }
    for (const value of [undefined, null, "", "unknown", true])
      assert.throws(
        () =>
          selectCourier(
            [
              {
                ...low,
                [field]: value,
                delivery_boy_contact: "Available",
                tracking_status: 1,
              },
            ],
            policy(filter)
          ),
        /No Shiprocket courier/
      )
  }
  assert.equal(
    selectCourier(
      [low],
      policy({
        require_real_time_tracking: true,
        pod: "instant",
        require_call_before_delivery: true,
      })
    ).courier_company_id,
    2
  )
  assert.throws(
    () => selectCourier([low], policy({ pod: "on_request" })),
    /No Shiprocket courier/
  )
  assert.equal(
    selectCourier(
      [{ ...low, pod_available: "On Request" }],
      policy({ pod: "on_request" })
    ).pod,
    "on_request"
  )
})
test("missing ETA is explicit and malformed values are not invented into estimates", () => {
  const quote = selectCourier(
    [{ ...low, estimated_delivery_days: "4 - 2", etd: "invalid" }],
    policy()
  )
  assert.equal(quote.estimated_delivery_days, null)
  assert.equal(quote.estimated_delivery_date, null)
  assert.equal(
    selectCourier([{ ...low, estimated_delivery_days: "2 - 4" }], policy())
      .estimated_delivery_days,
    "2 - 4"
  )
})
test("selected courier is preserved and changed price or lost eligibility fails", () => {
  assert.equal(
    selectCourier([low, high], policy(), undefined, 1).courier_company_id,
    1
  )
  assert.throws(
    () => selectCourier([low], policy(), undefined, 1),
    /no longer eligible/
  )
  assert.throws(
    () => selectCourier([low], policy({ pod: "on_request" }), undefined, 2),
    /no longer eligible/
  )
  const quote = selectCourier([low], policy())
  assertMatchingCourier({ courier_company_id: 2, amount: 50 }, quote)
  assert.throws(
    () => assertMatchingCourier({ courier_company_id: 1, amount: 50 }, quote),
    /changed/
  )
  assert.throws(
    () => assertMatchingCourier({ courier_company_id: 2, amount: 49 }, quote),
    /changed/
  )
})
test("invalid policy values fail configuration instead of silently weakening requirements", () => {
  assert.throws(
    () => courierPolicy({ courier_selection: "fast" }),
    /COURIER_SELECTION/
  )
  assert.throws(
    () => courierPolicy({ pod_requirement: "yes" }),
    /POD_REQUIREMENT/
  )
  assert.throws(
    () => courierPolicy({ require_real_time_tracking: "true" as any }),
    /true or false/
  )
})

test("optional preferences relax deterministically while exhausted hard matches remain unavailable", () => {
  const p = policy({
    fallback: "relax_preferences",
    preferred_call_before_delivery: true,
    preferred_pod: "instant",
    preferred_real_time_tracking: true,
  })
  const unknown = {
    ...low,
    realtime_tracking: undefined,
    pod_available: undefined,
    call_before_delivery: undefined,
  }
  const quote = selectCourier([unknown], p)
  assert.deepEqual(quote.relaxed_preferences, [
    "call_before_delivery",
    "pod",
    "real_time_tracking",
  ])
  assert.equal(quote.realtime_tracking, null)
  assert.equal(quote.pod, null)
  assert.equal(quote.call_before_delivery, null)
  assert.throws(
    () => selectCourier([unknown], { ...p, fallback: "none" }),
    /No Shiprocket courier/
  )
  assert.throws(
    () => selectCourier([unknown], { ...p, require_real_time_tracking: true }),
    /No Shiprocket courier/
  )
  assert.throws(() => selectCourier([], p), /No Shiprocket courier/)
  assert.equal(
    selectCourier([{ ...unknown, realtime_tracking: "MIS" }], policy())
      .realtime_tracking,
    false
  )
})
test("all hard/preference combinations and both rankings/fallback modes preserve required capabilities", () => {
  for (const selection of ["lowest_price", "highest_rating"]) {
    for (const fallback of ["none", "relax_preferences"]) {
      for (let hard = 0; hard < 8; hard++)
        for (let soft = 0; soft < 8; soft++) {
          const p = policy({
            selection,
            fallback,
            require_call_before_delivery: !!(hard & 1),
            pod: hard & 2 ? "instant" : "any",
            require_real_time_tracking: !!(hard & 4),
            preferred_call_before_delivery: !!(soft & 1),
            preferred_pod: soft & 2 ? "instant" : "any",
            preferred_real_time_tracking: !!(soft & 4),
          })
          const q = selectCourier(
            [
              low,
              high,
              {
                ...low,
                courier_company_id: 3,
                rate: 1,
                rating: null,
                realtime_tracking: undefined,
                pod_available: undefined,
                call_before_delivery: undefined,
              },
            ],
            p
          )
          if (hard & 1) assert.equal(q.call_before_delivery, true)
          if (hard & 2) assert.equal(q.pod, "instant")
          if (hard & 4) assert.equal(q.realtime_tracking, true)
          if (selection === "highest_rating")
            assert.equal(q.courier_company_id, 1)
          assert.deepEqual(q.relaxed_preferences, [])
        }
    }
  }
})
test("preserved courier records relaxed preferences or fails when fallback is disabled", () => {
  const p = policy({
    preferred_call_before_delivery: true,
    fallback: "relax_preferences",
  })
  const row = { ...low, call_before_delivery: "Not Available" }
  assert.deepEqual(selectCourier([row], p, undefined, 2).relaxed_preferences, [
    "call_before_delivery",
  ])
  assert.throws(
    () => selectCourier([row], { ...p, fallback: "none" }, undefined, 2),
    /no longer meets courier preferences/
  )
})

test("each delivery category chooses the best eligible actual courier", () => {
  const rows: any[] = [false, true].flatMap((surface, index) =>
    [1, 2, 3].map((n) => ({
      ...low,
      is_surface: surface,
      courier_company_id: index * 10 + n,
      rate: n * 10,
      rating: 5 - n / 10,
    }))
  )
  rows.push({ ...low, courier_company_id: 99, rate: 1, is_surface: undefined })
  const choices = courierChoices(rows, policy())
  assert.deepEqual(
    choices.map((q) => q.courier_company_id),
    [1, 11]
  )
  assert.deepEqual(
    choices.map((q) => q.service),
    ["air", "surface"]
  )
  assert.equal(courierChoices([rows[0], rows[0]], policy()).length, 1)
  assert.throws(
    () => courierChoices([{ ...low, is_surface: "false" }], policy()),
    /No eligible/
  )
  assert.equal(courierChoices([rows[0]], policy()).length, 1)
})

test("a courier changing transport category is not silently substituted", () => {
  const quote = selectCourier([{ ...low, is_surface: true }], policy())
  assert.throws(
    () =>
      assertMatchingCourier(
        {
          courier_company_id: quote.courier_company_id,
          amount: quote.amount,
          service: "air",
        },
        quote
      ),
    /changed/
  )
})
