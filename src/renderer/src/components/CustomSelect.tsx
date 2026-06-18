import React, { useEffect, useMemo, useRef, useState } from 'react'
import styles from './CustomSelect.module.css'

export type CustomSelectOption = {
  value: string
  label: string
  disabled?: boolean
}

interface Props {
  value: string
  options: CustomSelectOption[]
  onChange: (value: string) => void | Promise<void>
  disabled?: boolean
  title?: string
  rootClassName?: string
  triggerClassName?: string
  menuClassName?: string
  optionClassName?: string
  optionSelectedClassName?: string
}

const CustomSelect: React.FC<Props> = ({
  value,
  options,
  onChange,
  disabled = false,
  title,
  rootClassName,
  triggerClassName,
  menuClassName,
  optionClassName,
  optionSelectedClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [menuPlacement, setMenuPlacement] = useState<'below' | 'above'>('below')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0] ?? null,
    [options, value]
  )

  useEffect(() => {
    if (!isOpen) return

    const isEventInsideRoot = (eventTarget: EventTarget | null, event?: Event) => {
      const root = rootRef.current
      if (!root) return false

      if (event && typeof (event as Event & { composedPath?: () => EventTarget[] }).composedPath === 'function') {
        return (event as Event & { composedPath: () => EventTarget[] }).composedPath().includes(root)
      }

      return eventTarget instanceof Node ? root.contains(eventTarget) : false
    }

    const handlePointerDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
      if (!isEventInsideRoot(event.target, event)) {
        setIsOpen(false)
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (!isEventInsideRoot(event.target, event)) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('mousedown', handlePointerDown, true)
    window.addEventListener('touchstart', handlePointerDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('mousedown', handlePointerDown, true)
      window.removeEventListener('touchstart', handlePointerDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const updatePlacement = () => {
      const root = rootRef.current
      const menu = menuRef.current
      if (!root || !menu) return

      const rootRect = root.getBoundingClientRect()
      const menuHeight = menu.offsetHeight
      const viewportHeight = window.innerHeight
      const spaceBelow = viewportHeight - rootRect.bottom
      const spaceAbove = rootRect.top

      if (spaceBelow < menuHeight + 8 && spaceAbove > spaceBelow) {
        setMenuPlacement('above')
        return
      }

      setMenuPlacement('below')
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)

    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [isOpen, options.length])

  const handleSelect = (nextValue: string) => {
    setIsOpen(false)
    void onChange(nextValue)
  }

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${isOpen ? styles.rootOpen : ''} ${rootClassName ?? ''}`.trim()}
    >
      <button
        type="button"
        className={`${styles.trigger} ${triggerClassName ?? ''}`.trim()}
        onClick={() => {
          if (!disabled) {
            setIsOpen((prev) => !prev)
          }
        }}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={styles.label}>{selectedOption?.label ?? ''}</span>
        <svg className={styles.chevron} viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen && !disabled && (
        <div
          ref={menuRef}
          className={`${styles.menu} ${menuPlacement === 'above' ? styles.menuAbove : ''} ${menuClassName ?? ''}`.trim()}
          role="listbox"
        >
          {options.map((option) => {
            const isSelected = option.value === value
            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                className={`${styles.option} ${optionClassName ?? ''} ${isSelected ? `${styles.optionSelected} ${optionSelectedClassName ?? ''}` : ''}`.trim()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(option.value)}
              >
                <span className={styles.optionLabel}>{option.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default CustomSelect
