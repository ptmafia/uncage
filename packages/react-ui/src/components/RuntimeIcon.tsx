import { isImageDataUri, type RuntimeInfo } from '@uncage/protocol';
import type { JSX } from 'react';
import { cx } from '../context.js';

export interface RuntimeIconProps {
  runtime: Pick<RuntimeInfo, 'displayName' | 'icon'>;
  className?: string;
}

/**
 * A runtime's official icon. Only ever an `<img>` with a base64 svg/png data URI (re-checked
 * here; anything else is ignored), so an icon can never run script or make a third-party request.
 * With a `dark` variant both images render and CSS shows the one matching the theme. Without a
 * usable icon: a neutral badge with the name's initial.
 */
export function RuntimeIcon({ runtime, className }: RuntimeIconProps): JSX.Element {
  const light = runtime.icon?.light;
  const dark = runtime.icon?.dark;
  if (!isImageDataUri(light)) {
    return (
      <span className={cx('uc-runtime-icon', className)} data-fallback aria-hidden>
        {runtime.displayName.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  const themed = isImageDataUri(dark);
  return (
    <span className={cx('uc-runtime-icon', className)}>
      <img src={light} alt={runtime.displayName} data-variant={themed ? 'light' : 'any'} width={16} height={16} draggable={false} />
      {themed && <img src={dark} alt={runtime.displayName} data-variant="dark" width={16} height={16} draggable={false} />}
    </span>
  );
}
