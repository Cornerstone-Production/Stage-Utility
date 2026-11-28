// context-menu-target.tsx — a <div> that opens a menu on a right-click or a long press.
//
// `useContextMenuTrigger` is a hook, and a hook cannot be called once per item of a
// `.map`. This is the child component that makes it one call per item: render it where
// the row's own <div> would be.

import type { HTMLAttributes } from "react";

import { useContextMenuTrigger } from "./context-menu-trigger";

export function ContextMenuDiv({
  onOpenMenu,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { onOpenMenu: (at: { x: number; y: number }) => void }) {
  // `cancel` is for a caller with a competing gesture; a plain target has none.
  const { cancel: _cancel, style: pressStyle, ...trigger } = useContextMenuTrigger(onOpenMenu);
  return <div {...rest} {...trigger} style={{ ...style, ...pressStyle }} />;
}
