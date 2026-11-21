import { type ReactNode, useRef } from "react"
import { EllipsisHorizontal, PencilSquare } from "@medusajs/icons"
import {
  Container,
  DropdownMenu,
  Heading,
  IconButton,
  Text,
} from "@medusajs/ui"
export function SettingsActions({
  name,
  disabled,
  onEdit,
}: {
  name: string
  disabled?: boolean
  onEdit: (trigger: HTMLElement | null) => void
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
          disabled={disabled}
        >
          <EllipsisHorizontal />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        onCloseAutoFocus={(event) => {
          if (editing.current) {
            event.preventDefault()
            editing.current = false
          }
        }}
      >
        <DropdownMenu.Item
          className="flex items-center gap-x-2"
          onSelect={() => {
            editing.current = true
            onEdit(trigger.current)
          }}
        >
          <PencilSquare />
          Edit
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
export function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Container className="divide-y p-0">
      <div className="flex items-start justify-between gap-x-4 px-6 py-4">
        <div>
          <Heading level="h2">{title}</Heading>
          {description && (
            <Text size="small" className="text-ui-fg-subtle">
              {description}
            </Text>
          )}
        </div>
        {action}
      </div>
      {children}
    </Container>
  )
}
export function SettingsRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 px-6 py-4">
      <Text
        size="small"
        leading="compact"
        weight="plus"
        className="text-ui-fg-subtle"
      >
        {label}
      </Text>
      <div className="min-w-0 break-words text-ui-fg-subtle">
        {typeof children === "string" ? (
          <Text size="small" leading="compact">
            {children}
          </Text>
        ) : (
          children
        )}
      </div>
    </div>
  )
}
export function SettingsLoading({ title }: { title: string }) {
  return (
    <SettingsCard title={title}>
      <div
        role="status"
        aria-label={`Loading ${title}`}
        className="animate-pulse px-6 py-4"
      >
        <span className="sr-only">Loading…</span>
        {[1, 2, 3].map((n) => (
          <div key={n} className="flex justify-between py-3">
            <div
              className="bg-ui-bg-component rounded-sm"
              style={{ width: "30%", height: 16 }}
            />
            <div
              className="bg-ui-bg-component rounded-sm"
              style={{ width: "40%", height: 16 }}
            />
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}
