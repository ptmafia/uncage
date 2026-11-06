import { memo, type JSX } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_SCHEME = /^(?:https?|mailto):/i;
// Browsers ignore ASCII whitespace/control characters inside a scheme ("java\tscript:").
// eslint-disable-next-line no-control-regex
const IGNORED_CHARS = /[\u0000- \u007f]/g;

/**
 * Keeps only http(s), mailto, relative URLs and #anchors. Anything else with a scheme
 * (`javascript:`, `data:`, `vbscript:`, …) is dropped.
 */
export const safeUrl: UrlTransform = (url) => {
  const normalized = url.replace(IGNORED_CHARS, '');
  const colon = normalized.indexOf(':');
  const delimiter = normalized.search(/[/?#]/);
  const relative = colon === -1 || (delimiter !== -1 && delimiter < colon);
  return relative || SAFE_SCHEME.test(normalized) ? url : '';
};

const EXTERNAL = /^(?:https?:)?\/\//i;

const components: Components = {
  a({ href, children, node: _node, ...rest }) {
    void _node;
    if (!href) return <span className="uc-md-link-dropped">{children}</span>;
    const external = EXTERNAL.test(href);
    return (
      <a href={href} {...rest} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  },
  // Remote images would load (and could leak data) the moment they render: show them as links instead.
  img({ src, alt }) {
    const href = typeof src === 'string' ? src : '';
    const label = alt || href;
    if (!href) return <span>{label}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="uc-md-image-link">
        {label}
      </a>
    );
  },
};

const REMARK = [remarkGfm];

/** Model-output Markdown (GFM). Raw HTML renders as text; unsafe URLs are dropped. */
export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="uc-prose">
      <ReactMarkdown remarkPlugins={REMARK} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
