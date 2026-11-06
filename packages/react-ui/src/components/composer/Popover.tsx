import { Check } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '../../context.js';

export interface PopoverItem {
  id: string;
  label: string;
  description?: string;
  /** Current choice (menuitemradio): shows a check and `aria-checked`. */
  checked?: boolean;
  tone?: 'err';
}

export interface PopoverProps {
  /** Accessible name of the menu. */
  label: string;
  /** Accessible name of the trigger button. */
  triggerLabel: string;
  /** Visible trigger content (icon, text, chevron). */
  trigger: ReactNode;
  triggerClassName?: string;
  triggerTone?: 'err';
  disabled?: boolean;
  items: PopoverItem[];
  /** `menuitemradio` for a choice (default), `menuitem` for actions. */
  itemRole?: 'menuitemradio' | 'menuitem';
  onSelect(id: string): void;
  /** A note under the items (e.g. "Applies to the next run"). */
  footnote?: string;
  /** Receives the trigger element, e.g. to return focus after a follow-up dialog. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * A dependency-free menu button. The menu opens above its trigger (the composer sits at the bottom
 * of the page). Keyboard: ArrowDown/ArrowUp on the trigger open it; inside, arrows move (wrapping),
 * Home/End jump, Enter/Space choose, Esc closes; focus returns to the trigger. Tab or a pointer
 * press outside closes it.
 */
export function Popover({
  label,
  triggerLabel,
  trigger,
  triggerClassName,
  triggerTone,
  disabled = false,
  items,
  itemRole = 'menuitemradio',
  onSelect,
  footnote,
  triggerRef,
}: PopoverProps): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<'checked' | 'last'>('checked');
  const anchor = useRef<HTMLDivElement>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const triggerEl = () => ownTrigger.current;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerEl()?.focus();
  };

  // Focus the current choice (or the first/last item) when the menu opens.
  useEffect(() => {
    if (!open) return;
    const checked = items.findIndex((i) => i.checked);
    const index = initial === 'last' ? items.length - 1 : Math.max(0, checked);
    itemRefs.current[index]?.focus();
    // Only on open: later item changes must not steal focus.
  }, [open]);

  // Close on a pointer press outside the trigger and menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (anchor.current && e.target instanceof Node && !anchor.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // A disabled trigger cannot hold an open menu.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (itemId: string) => {
    close(true);
    onSelect(itemId);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    setInitial(e.key === 'ArrowUp' ? 'last' : 'checked');
    setOpen(true);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nodes = itemRefs.current.filter((n): n is HTMLButtonElement => n !== null);
    const at = nodes.findIndex((n) => n === document.activeElement);
    const focus = (i: number) => nodes[(i + nodes.length) % nodes.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(at < 0 ? nodes.length - 1 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focus(0);
        break;
      case 'End':
        e.preventDefault();
        focus(nodes.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = at >= 0 ? items[at] : undefined;
        if (item) choose(item.id);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className="uc-popover-anchor" ref={anchor}>
      <button
        ref={(el) => {
          ownTrigger.current = el;
          if (triggerRef) triggerRef.current = el;
        }}
        type="button"
        className={cx('uc-btn uc-btn-ghost uc-tool', triggerClassName)}
        data-tone={triggerTone}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={disabled}
        onClick={() => {
          setInitial('checked');
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open && (
        <div className="uc-popover">
          <div
            id={`${id}-menu`}
            role="menu"
            aria-label={label}
            aria-describedby={footnote ? `${id}-foot` : undefined}
            className="uc-menu"
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, i) => (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={itemRole}
                tabIndex={-1}
                className="uc-menu-item"
                data-tone={item.tone}
                aria-checked={itemRole === 'menuitemradio' ? item.checked === true : undefined}
                aria-labelledby={`${id}-${i}-label`}
                aria-describedby={item.description ? `${id}-${i}-desc` : undefined}
                onClick={() => choose(item.id)}
              >
                <span className="uc-menu-text">
                  <span id={`${id}-${i}-label`} className="uc-menu-label">
                    {item.label}
                  </span>
                  {item.description && (
                    <span id={`${id}-${i}-desc`} className="uc-menu-desc">
                      {item.description}
                    </span>
                  )}
                </span>
                {itemRole === 'menuitemradio' && (
                  <span className="uc-menu-check" aria-hidden>
                    {item.checked && <Check />}
                  </span>
                )}
              </button>
            ))}
          </div>
          {footnote && (
            <p id={`${id}-foot`} className="uc-menu-foot">
              {footnote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
