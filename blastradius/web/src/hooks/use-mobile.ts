import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * How long a breakpoint change must hold before it is applied. The shadcn Sidebar renders a
 * different tree for mobile (a Sheet) and desktop, so every flip remounts the whole nav and
 * closes any open menu in it (the user menu, the org switcher). Browsers report transient
 * sizes that are not real layouts: Chromium shrinks the viewport to 1x1 for ~25 ms while it
 * takes a full-page capture, and window snapping or zooming can pass through the breakpoint.
 * Only a size that sticks switches the layout.
 */
export const MOBILE_SETTLE_MS = 150

function isMobileNow(): boolean {
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  // Read the real value on the first render, so a phone does not render (and then remount)
  // the desktop sidebar first.
  const [isMobile, setIsMobile] = React.useState<boolean>(isMobileNow)

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(QUERY)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setIsMobile(isMobileNow()), MOBILE_SETTLE_MS)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(isMobileNow())
    return () => {
      clearTimeout(timer)
      mql.removeEventListener("change", onChange)
    }
  }, [])

  return isMobile
}
