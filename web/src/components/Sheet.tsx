"use client";

import { Drawer } from "vaul";

type Props = {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: string;
  /** Required steps (choosing a username) can't be swiped away. */
  dismissible?: boolean;
  children: React.ReactNode;
};

/** Bottom sheet with drag-to-dismiss. All secondary flows live here so the main screens stay flat. */
export function Sheet({ open, onOpenChange, title, description, dismissible = true, children }: Props) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} dismissible={dismissible} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content
          aria-describedby={description ? undefined : ""}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-lg rounded-t-[1.5rem] bg-surface px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-text outline-none"
        >
          <div aria-hidden className="mx-auto mb-5 h-1 w-9 rounded-full bg-sep-strong" />
          <Drawer.Title className="text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</Drawer.Title>
          {description && <Drawer.Description className="mt-1 text-[15px] text-text-2">{description}</Drawer.Description>}
          <div className="mt-5">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export const sheetInput =
  "h-13 w-full rounded-2xl border border-transparent bg-bg px-4 text-[17px] outline-none transition-[border-color,box-shadow] duration-200 ease-out placeholder:text-text-2 focus:border-text/25 focus:ring-4 focus:ring-halo";

export const sheetPrimary =
  "press mt-3 flex h-13 w-full items-center justify-center rounded-2xl bg-ink text-[17px] font-semibold text-on-ink disabled:opacity-40";
