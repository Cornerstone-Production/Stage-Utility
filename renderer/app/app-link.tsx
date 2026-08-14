// An in-app link that takes an ordinary path string.
//
// TanStack types `Link`'s `to` against the REGISTERED route tree, and this app
// deliberately does not register: renderer/main/router.tsx (the kiosk) already
// claims the augmentation, and the declaration is global to the project, so two
// routers claiming it fails with TS2717.
//
// The cast is therefore made once, here, rather than at every call site. Paths
// are not unchecked in practice: routes.test.tsx asserts the destination set
// against the server's own table, which is a stronger guarantee than the
// literal-union check would give.

import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

type LinkProps = Omit<ComponentProps<typeof Link>, "to">;

export function AppLink({
  to,
  children,
  ...rest
}: LinkProps & { to: string; children: ReactNode }) {
  return (
    <Link to={to as never} {...rest}>
      {children}
    </Link>
  );
}
