import { isImageDataUri, type RuntimeInfo } from '@uncage/protocol';
import type { JSX } from 'react';
import { cx } from '../context.js';

export interface RuntimeIconProps {
  runtime: Pick<RuntimeInfo, 'displayName' | 'icon'>;
  className?: string;
  /**
   * Default true: shown next to the runtime's name, so `alt=""` (the name is not read twice).
   * False for an icon standing alone: `alt` is the runtime's display name.
   */
  decorative?: boolean;
}

/**
 * A runtime's official icon. Only ever an `<img>` with a base64 svg/png data URI (re-checked
 * here; anything else is ignored), so an icon can never run script or make a third-party request.
 * With a `dark` variant both images render and CSS shows the one matching the theme. Without a
 * usable icon: a neutral badge with the name's initial.
 */
export function RuntimeIcon({ runtime, className, decorative = true }: RuntimeIconProps): JSX.Element {
  const light = runtime.icon?.light;
  const dark = runtime.icon?.dark;
  if (!isImageDataUri(light)) {
    return (
      <span
        className={cx('uc-runtime-icon', className)}
        data-fallback
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': runtime.displayName })}
      >
        {runtime.displayName.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  const themed = isImageDataUri(dark);
  const alt = decorative ? '' : runtime.displayName;
  return (
    <span className={cx('uc-runtime-icon', className)}>
      <img src={light} alt={alt} data-variant={themed ? 'light' : 'any'} width={16} height={16} draggable={false} />
      {themed && <img src={dark} alt={alt} data-variant="dark" width={16} height={16} draggable={false} />}
    </span>
  );
}
