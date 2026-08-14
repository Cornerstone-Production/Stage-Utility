// Rail + content. The one layout every operator surface renders inside, which
// is what makes the app feel like one program rather than a set of pages that
// happen to share a server.
//
// The live context bar mounts above the content in the next commit.

import { Outlet } from "@tanstack/react-router";
import { Rail } from "./rail";

export function Shell() {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-bg">
      <Rail />
      <div className="flex flex-col flex-1 min-w-0">
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
