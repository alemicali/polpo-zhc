import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Segmented control, styled like the TabsList: a muted track with the active item raised
 * (bg-background + shadow-card + text-foreground) and the others text-muted-foreground.
 * Use it for every "pick one of a few" switch (view toggles, periods, modes), so they all
 * share one height, radius and type size.
 */
const toggleGroupVariants = cva(
  "group/toggle-group inline-flex w-fit shrink-0 items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground",
  {
    variants: {
      size: {
        default: "h-9",
        sm: "h-8",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const toggleGroupItemVariants = cva(
  "inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent font-medium whitespace-nowrap text-muted-foreground transition-[color,box-shadow,background-color] outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-card dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: "min-w-8 px-3 text-sm",
        sm: "min-w-7 px-2.5 text-small",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

type ToggleGroupSize = VariantProps<typeof toggleGroupVariants>["size"]

const ToggleGroupContext = React.createContext<{ size: ToggleGroupSize }>({
  size: "default",
})

function ToggleGroup({
  className,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleGroupVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-size={size ?? "default"}
      className={cn(toggleGroupVariants({ size }), className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleGroupItemVariants>) {
  const context = React.useContext(ToggleGroupContext)
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        toggleGroupItemVariants({ size: size ?? context.size }),
        className
      )}
      {...props}
    />
  )
}

/**
 * Single-choice ToggleGroup bound to a value: never empties (clicking the active item keeps it),
 * exposes radio semantics (role="radiogroup" + role="radio"/aria-checked on the items).
 */
function SegmentedControl<T extends string>({
  value,
  onValueChange,
  size,
  className,
  disabled,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "defaultValue" | "dir" | "onChange"> &
  VariantProps<typeof toggleGroupVariants> & {
    value: T
    onValueChange: (value: T) => void
    disabled?: boolean
  }) {
  return (
    <ToggleGroup
      type="single"
      role="radiogroup"
      size={size}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onValueChange(next as T)
      }}
      className={className}
      {...props}
    >
      {children}
    </ToggleGroup>
  )
}

export {
  ToggleGroup,
  ToggleGroupItem,
  SegmentedControl,
}
