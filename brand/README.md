# Uncage brand

The source of truth for the Uncage logo and design tokens, used by the website (`apps/site`) and the help site (`apps/docs`).

## Logo

The mark is an open padlock: the shackle, in the accent orange, has swung free; the body, in ink, holds a terminal prompt (`>_`). It stands for your coding agent, let out of the local machine. It is drawn on a 32-unit grid with a 2.4 stroke, and the outer edges land on whole units, so it stays crisp at 16 and 32 px.

| File | Use |
| --- | --- |
| `logo-mark.svg` | Mark on light backgrounds |
| `logo-mark-dark.svg` | Mark on dark backgrounds |
| `logo-horizontal.svg` | Mark and wordmark on light backgrounds |
| `logo-horizontal-dark.svg` | Mark and wordmark on dark backgrounds |
| `favicon.svg` | Browser favicon; follows `prefers-color-scheme` |
| `png/favicon-32.png` | 32 px fallback favicon (transparent) |
| `png/apple-touch-icon.png` | 180 px iOS home-screen icon (paper tile) |
| `png/icon-512.png` | 512 px app/social/avatar icon (paper tile) |

The wordmark "Uncage" is [Geist](https://github.com/vercel/geist-font) (SIL Open Font License 1.1) at weight 620 with -0.02 em tracking, converted to outlines, so the SVGs need no font. In the horizontal lockup the wordmark's baseline sits on the lock body's bottom stroke and its cap height matches the body.

Keep clear space of at least the shackle's width around the logo. Don't recolor the parts separately, add effects, or redraw the wordmark in another font.

Regenerate the PNGs after you change the mark (this uses the system Chrome through Playwright and downloads nothing):

```sh
node scripts/brand-png.mjs
```

## Colors and tokens

`tokens.css` defines the CSS custom properties. Light is the default. Dark applies under `[data-theme='dark']`, or with the OS dark preference unless `[data-theme='light']` is set.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--uc-paper` | `#f7f3ec` | `#171512` | Page background |
| `--uc-paper-2` | `#efe8dc` | `#211e1a` | Raised/inset surfaces, inline code |
| `--uc-ink` | `#1f2328` | `#efe9df` | Headings, strong text, logo body |
| `--uc-ink-2` | `#4a4f57` | `#c9c1b4` | Body text |
| `--uc-ink-3` | `#7b8089` | `#9a9286` | Muted text and metadata |
| `--uc-line` | `#e2d9ca` | `#34302a` | Borders and hairlines |
| `--uc-accent` | `#c4651a` | `#e08a45` | Brand orange: logo, large text, UI accents |
| `--uc-accent-ink` | `#a14f0c` | `#e08a45` | Accent for links and running text |
| `--uc-accent-soft` | `#fbe7d3` | `#3a2616` | Tinted backgrounds (badges, eyebrows) |
| `--uc-code` | `#1d1b18` | `#0f0e0c` | Terminal/code panels |
| `--uc-radius` | `14px` | | Default corner radius |
| `--uc-font-sans` | system UI stack | | Text |
| `--uc-font-mono` | system mono stack | | Code |

Contrast (WCAG 2.1) on `--uc-paper`:

- Light: ink 14.3, ink-2 7.5, accent-ink 5.2. `--uc-accent` is 3.6, which passes for large text and UI parts but not for body text, so use `--uc-accent-ink` for links. `--uc-ink-3` is 3.6, so keep it for secondary text at 14 px or larger, never for content people must read.
- Dark: ink 15.1, ink-2 10.2, ink-3 5.9, accent 6.9. All pass AA.
