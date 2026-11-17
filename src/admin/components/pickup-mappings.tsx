import { EllipsisHorizontal, PencilSquare, Trash, Plus } from "@medusajs/icons"
import {
  Badge,
  StatusBadge,
  Button,
  Container,
  DropdownMenu,
  IconButton,
  Drawer,
  Heading,
  Input,
  Label,
  Select,
  Table,
  Text,
  usePrompt,
} from "@medusajs/ui"
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { sdk } from "../lib/client"
type Pickup = {
  id: string
  nickname: string
  address: string
  address_2: string
  city: string
  state: string
  country: string
  postcode: string
}
type Location = {
  id: string
  name: string
  revision: string
  pickup_id: string | null
  scope_matches: boolean
  status: "unmapped" | "mapped" | "different_connection" | "pickup_missing"
  provider_linked: boolean
}
type Catalog = {
  pickups: Pickup[]
  locations: Location[]
  scope: string
  mode: "test" | "live"
}
type Draft = {
  action: "create" | "update"
  pickup_id: string
  location_id: string
  revision: string
}
function MappingActions({
  name,
  busy,
  canEdit,
  canMap,
  onEdit,
  onRemove,
  onMap,
}: {
  name: string
  busy: boolean
  canEdit: boolean
  canMap: boolean
  onEdit?: (trigger: HTMLElement | null) => void
  onRemove?: () => void
  onMap?: (trigger: HTMLElement | null) => void
}) {
  const trigger = useRef<HTMLButtonElement | null>(null),
    editing = useRef(false)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger asChild>
        <IconButton
          ref={trigger}
          size="small"
          variant="transparent"
          aria-label={`Actions for ${name}`}
          disabled={busy}
        >
          <EllipsisHorizontal />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        onCloseAutoFocus={(e) => {
          if (editing.current) {
            e.preventDefault()
            editing.current = false
          }
        }}
      >
        {onEdit && (
          <DropdownMenu.Item
            disabled={!canEdit}
            onSelect={() => {
              editing.current = true
              onEdit(trigger.current)
            }}
          >
            <PencilSquare />
            Edit mapping
          </DropdownMenu.Item>
        )}
        {onMap && (
          <DropdownMenu.Item
            disabled={!canMap}
            onSelect={() => {
              editing.current = true
              onMap(trigger.current)
            }}
          >
            <Plus />
            Map location
          </DropdownMenu.Item>
        )}
        {onRemove && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item className="text-ui-fg-error" onSelect={onRemove}>
              <Trash />
              Remove mapping
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
export default function PickupMappings({
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
      sdk.client.fetch<{ configured: boolean; revision: number }>(
        "/admin/shiprocket-settings"
      ),
  })
  const catalog = useQuery({
    queryKey: ["shiprocket-pickup-mappings", connection.data?.revision],
    enabled: canRead && connection.data?.configured === true,
    retry: false,
    queryFn: () =>
      sdk.client.fetch<Catalog>("/admin/shiprocket-pickup-mappings"),
  })
  const initialDraft = useRef<Draft | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null),
    heading = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0)
  useEffect(() => {
    setDraft(null)
    setError("")
    setMessage("")
    setPage(0)
  }, [connection.data?.revision])
  const rows = useMemo(() => {
    const data = catalog.data
    if (!data) return []
    const result: { pickup: Pickup | null; location: Location | null }[] = []
    for (const pickup of data.pickups) {
      const linked = data.locations.filter(
        (l) => l.pickup_id === pickup.id && l.scope_matches
      )
      if (linked.length)
        for (const location of linked) result.push({ pickup, location })
      else result.push({ pickup, location: null })
    }
    for (const location of data.locations.filter(
      (l) => l.pickup_id && l.status !== "mapped"
    ))
      result.push({ pickup: null, location })
    return result.filter(({ pickup, location }) =>
      [
        pickup?.nickname,
        pickup?.id,
        pickup?.city,
        pickup?.postcode,
        pickup?.address,
        pickup?.address_2,
        pickup?.state,
        location?.name,
        location?.pickup_id,
      ].some((value) =>
        value?.toLowerCase().includes(search.toLowerCase().trim())
      )
    )
  }, [catalog.data, search])
  const available = catalog.data?.locations.filter((l) => !l.pickup_id) || []
  const pageCount = Math.max(1, Math.ceil(rows.length / 10)),
    currentPage = Math.min(page, pageCount - 1)
  function begin(
    value: Draft,
    trigger: HTMLElement | null = document.activeElement as HTMLElement | null
  ) {
    returnFocus.current = trigger
    initialDraft.current = { ...value }
    setError("")
    setMessage("")
    setDraft(value)
  }
  async function close() {
    if (busy) return
    if (
      JSON.stringify(draft) !== JSON.stringify(initialDraft.current) &&
      !(await prompt({
        title: "Discard changes?",
        description: "Your pickup mapping changes have not been saved.",
        confirmText: "Discard",
        cancelText: "Keep editing",
      }))
    )
      return
    setDraft(null)
    setError("")
  }
  async function changed() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["shiprocket-pickup-mappings"] }),
      cache.invalidateQueries({ queryKey: ["shiprocket-pickups"] }),
      cache.invalidateQueries({ queryKey: ["stock_locations"] }),
    ])
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !catalog.data || busy || !canWrite) return
    const location = catalog.data.locations.find(
      (l) => l.id === draft.location_id
    )
    if (!location) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await sdk.client.fetch("/admin/shiprocket-pickup-mappings", {
        method: "POST",
        body: {
          ...draft,
          scope: catalog.data.scope,
          revision:
            draft.action === "create" ? location.revision : draft.revision,
        },
      })
      setDraft(null)
      setMessage("Pickup mapping saved.")
      await changed()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Mapping could not be saved. Reload and try again."
      )
    } finally {
      setBusy(false)
    }
  }
  async function remove(location: Location) {
    if (!catalog.data || busy || !canWrite) return
    const scope = catalog.data.scope
    if (
      !(await prompt({
        title: "Remove pickup mapping?",
        description: `Remove the pickup link for ${location.name}? The stock location and Shiprocket address will remain available.`,
        confirmText: "Remove mapping",
        cancelText: "Cancel",
      }))
    )
      return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await sdk.client.fetch("/admin/shiprocket-pickup-mappings", {
        method: "POST",
        body: {
          action: "remove",
          location_id: location.id,
          revision: location.revision,
          scope,
        },
      })
      setMessage("Pickup mapping removed.")
      await changed()
      heading.current?.focus()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Mapping could not be removed. Reload and try again."
      )
    } finally {
      setBusy(false)
    }
  }
  const reload = () => {
    setDraft(null)
    setError("")
    setMessage("")
    void catalog.refetch()
  }
  if (!canRead) return null
  return (
    <Container className="divide-y p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div ref={heading} tabIndex={-1} className="flex items-center gap-x-2">
          <Heading level="h2">Pickup mappings</Heading>
          {catalog.data && (
            <Badge
              size="2xsmall"
              color={catalog.data.mode === "live" ? "green" : "grey"}
            >
              {catalog.data.mode === "live" ? "Live" : "Test"}
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          {canWrite && (
            <Button
              size="small"
              variant="secondary"
              disabled={
                busy || !catalog.data?.pickups.length || !available.length
              }
              onClick={() => {
                setError("")
                setMessage("")
                begin({
                  action: "create",
                  pickup_id: "",
                  location_id: available.length === 1 ? available[0].id : "",
                  revision: "",
                })
              }}
            >
              Add mapping
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            disabled={!catalog.data || catalog.isFetching || busy}
            onClick={reload}
          >
            Refresh
          </Button>
        </div>
      </div>
      {connection.isPending ? (
        <Text role="status" className="px-6 pb-4">
          Loading connection…
        </Text>
      ) : connection.isError ? (
        <div className="px-6 pb-4">
          <Text role="alert">The saved connection could not be loaded.</Text>
          <Button variant="secondary" onClick={() => connection.refetch()}>
            Retry
          </Button>
        </div>
      ) : !connection.data?.configured ? (
        <Text className="px-6 pb-4">
          Save verified credentials before managing pickup mappings.
        </Text>
      ) : catalog.isPending ? (
        <Text role="status" className="px-6 pb-4">
          Loading pickup addresses and locations…
        </Text>
      ) : catalog.isError ? (
        <div className="px-6 pb-4">
          <Text role="alert">
            Pickup mappings could not be loaded. Check the connection and
            refresh.
          </Text>
          <Button variant="secondary" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="px-6 py-3">
            <div className="w-full" style={{ maxWidth: 320 }}>
              <Input
                type="search"
                aria-label="Search pickup mappings"
                placeholder="Search pickup or location"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
              />
            </div>
          </div>
          {error && !draft && (
            <Text role="alert" className="px-6 pb-4 text-ui-fg-error">
              {error}
            </Text>
          )}
          {message && (
            <Text role="status" className="px-6 pb-4">
              {message}
            </Text>
          )}
          <div className="overflow-x-auto">
            <Table
              style={{ minWidth: 880, tableLayout: "fixed" }}
              aria-label="Shiprocket pickup mappings"
            >
              <colgroup>
                <col style={{ width: "24%" }} />
                <col />
                <col style={{ width: "20%" }} />
                <col style={{ width: 176 }} />
                {canWrite && <col style={{ width: 64 }} />}
              </colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Pickup</Table.HeaderCell>
                  <Table.HeaderCell>Address</Table.HeaderCell>
                  <Table.HeaderCell>Stock location</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  {canWrite && (
                    <Table.HeaderCell>
                      <span className="sr-only">Actions</span>
                    </Table.HeaderCell>
                  )}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows
                  .slice(currentPage * 10, currentPage * 10 + 10)
                  .map(({ pickup, location }, index) => (
                    <Table.Row
                      key={`${pickup?.id || "saved"}:${location?.id || index}`}
                    >
                      <Table.Cell>
                        <div className="flex min-w-0 flex-col gap-y-1 py-3">
                          <Text
                            size="small"
                            weight="plus"
                            className="truncate text-ui-fg-base"
                            title={
                              pickup?.nickname ||
                              `Pickup ${location?.pickup_id}`
                            }
                          >
                            {pickup?.nickname ||
                              `Pickup ${pickup?.id || location?.pickup_id}`}
                          </Text>
                          <Text size="small" className="text-ui-fg-muted">
                            #{pickup?.id || location?.pickup_id}
                          </Text>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex flex-col gap-y-1 py-3">
                          {pickup ? (
                            <>
                              <Text size="small" className="break-words">
                                {[pickup.address, pickup.address_2]
                                  .filter(Boolean)
                                  .join(", ") || "—"}
                              </Text>
                              <Text
                                size="small"
                                className="break-words text-ui-fg-muted"
                              >
                                {[pickup.city, pickup.state, pickup.postcode]
                                  .filter(Boolean)
                                  .join(", ")}
                              </Text>
                            </>
                          ) : (
                            <Text size="small" className="text-ui-fg-muted">
                              Unavailable
                            </Text>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        {location ? (
                          <>
                            <Link
                              className="block truncate text-ui-fg-base hover:underline"
                              title={location.name}
                              to={`/settings/locations/${encodeURIComponent(location.id)}`}
                            >
                              {location.name}
                            </Link>
                            {!location.provider_linked && (
                              <Text size="small">
                                Shiprocket provider not linked.
                              </Text>
                            )}
                          </>
                        ) : (
                          <span
                            className="text-ui-fg-muted"
                            aria-label="No stock location"
                          >
                            —
                          </span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <StatusBadge
                          color={
                            location?.status === "mapped"
                              ? "green"
                              : location
                                ? "orange"
                                : "grey"
                          }
                        >
                          {!location
                            ? "Not mapped"
                            : location.status === "different_connection"
                              ? "Different connection"
                              : location.status === "pickup_missing"
                                ? "Address unavailable"
                                : "Mapped"}
                        </StatusBadge>
                      </Table.Cell>
                      {canWrite && (
                        <Table.Cell>
                          <MappingActions
                            name={
                              location?.name || pickup?.nickname || "pickup"
                            }
                            busy={busy}
                            canEdit={Boolean(catalog.data?.pickups.length)}
                            canMap={Boolean(available.length)}
                            onEdit={
                              location
                                ? (trigger) =>
                                    begin(
                                      {
                                        action: "update",
                                        location_id: location.id,
                                        revision: location.revision,
                                        pickup_id: pickup?.id || "",
                                      },
                                      trigger
                                    )
                                : undefined
                            }
                            onRemove={
                              location
                                ? () => {
                                    void remove(location)
                                  }
                                : undefined
                            }
                            onMap={
                              !location
                                ? (trigger) =>
                                    begin(
                                      {
                                        action: "create",
                                        pickup_id: pickup!.id,
                                        location_id:
                                          available.length === 1
                                            ? available[0].id
                                            : "",
                                        revision: "",
                                      },
                                      trigger
                                    )
                                : undefined
                            }
                          />
                        </Table.Cell>
                      )}
                    </Table.Row>
                  ))}
              </Table.Body>
            </Table>
          </div>
          {!rows.length && (
            <Text className="px-6 py-4">
              {search
                ? "No matching pickup mappings."
                : "No pickup addresses are available in this connection."}
            </Text>
          )}
          {!catalog.data?.locations.length && (
            <Text className="px-6 py-4">
              Add stock locations in Locations & shipping before mapping pickup
              addresses.
            </Text>
          )}
          <Table.Pagination
            className="flex-wrap gap-y-2"
            count={rows.length}
            pageSize={10}
            pageCount={pageCount}
            pageIndex={currentPage}
            canPreviousPage={currentPage > 0 && !busy}
            canNextPage={currentPage + 1 < pageCount && !busy}
            previousPage={() => setPage(currentPage - 1)}
            nextPage={() => setPage(currentPage + 1)}
          />
        </>
      )}
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
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            ;(returnFocus.current?.isConnected
              ? returnFocus.current
              : heading.current
            )?.focus()
          }}
        >
          <Drawer.Header>
            <Drawer.Title>
              {draft?.action === "update"
                ? "Edit pickup mapping"
                : "Map pickup address"}
            </Drawer.Title>
            <Drawer.Description className="sr-only">
              Choose existing records to link.
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
              <div className="flex flex-col gap-y-8">
                <div>
                  <Label htmlFor="pickup-mapping-address">
                    Shiprocket pickup address
                  </Label>
                  <Select
                    value={draft?.pickup_id || undefined}
                    disabled={busy}
                    onValueChange={(pickup_id) =>
                      setDraft((value) =>
                        value ? { ...value, pickup_id } : null
                      )
                    }
                  >
                    <Select.Trigger id="pickup-mapping-address">
                      <Select.Value placeholder="Select pickup address" />
                    </Select.Trigger>
                    <Select.Content>
                      {catalog.data?.pickups.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          {p.nickname} · {p.city} {p.postcode} · ID {p.id}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="pickup-mapping-location">
                    Medusa stock location
                  </Label>
                  <Select
                    value={draft?.location_id || undefined}
                    disabled={busy || draft?.action === "update"}
                    onValueChange={(location_id) =>
                      setDraft((value) =>
                        value ? { ...value, location_id } : null
                      )
                    }
                  >
                    <Select.Trigger id="pickup-mapping-location">
                      <Select.Value placeholder="Select existing location" />
                    </Select.Trigger>
                    <Select.Content>
                      {(draft?.action === "update"
                        ? catalog.data?.locations
                        : available
                      )?.map((l) => (
                        <Select.Item key={l.id} value={l.id}>
                          {l.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                {error && (
                  <div>
                    <Text role="alert" className="text-ui-fg-error">
                      {error}
                    </Text>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={reload}
                    >
                      Reload table
                    </Button>
                  </div>
                )}
              </div>
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !draft?.pickup_id || !draft.location_id}
                isLoading={busy}
              >
                Save mapping
              </Button>
            </Drawer.Footer>
          </form>
        </Drawer.Content>
      </Drawer>
    </Container>
  )
}
