import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function visibleFocusable(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) =>
      element.tabIndex >= 0
      && element.getClientRects().length > 0
      && element.getAttribute('aria-hidden') !== 'true')
}

export function useModalFocus<T extends HTMLElement>(
  onClose: () => void,
  initialFocusSelector?: string,
  returnFocus?: HTMLElement | null,
  active = true,
  restoreFocus = true,
): RefObject<T | null> {
  const containerRef = useRef<T>(null)
  const closeRef = useRef(onClose)

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!active) return
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const container = containerRef.current
    if (!container) return

    const focusable = () => visibleFocusable(container)
    const frame = requestAnimationFrame(() => {
      const preferred = initialFocusSelector
        ? container.querySelector<HTMLElement>(initialFocusSelector)
        : null
      ;(preferred || focusable()[0] || container).focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusable()
      if (!items.length) {
        event.preventDefault()
        container.focus()
        return
      }

      event.preventDefault()
      const current = document.activeElement instanceof HTMLElement
        ? items.indexOf(document.activeElement)
        : -1
      const offset = event.shiftKey ? -1 : 1
      const next = current === -1
        ? (event.shiftKey ? items.length - 1 : 0)
        : (current + offset + items.length) % items.length
      items[next].focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      if (!restoreFocus) return
      if (returnFocus?.isConnected) {
        returnFocus.focus()
      } else if (previous?.isConnected && previous !== document.body) {
        previous.focus()
      } else {
        document.querySelector<HTMLElement>('.main-stage')?.focus()
      }
    }
  }, [active, initialFocusSelector, restoreFocus, returnFocus])

  return containerRef
}
