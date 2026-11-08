/**
 * The shape of every homepage dictionary. `en`, `zh` and `ja` are all typed `Dict`, so a missing key
 * (or a missing list item: lists are fixed-length tuples) in any language is a type error.
 *
 * Copy only. Code, commands, URLs and package names live in the components / src/snippets.
 */

export interface Feature {
  title: string;
  body: string;
}

export interface Step {
  /** Short label after the number, e.g. "Connect". */
  tag: string;
  title: string;
  body: string;
}

export interface TrustPoint {
  title: string;
  /** May contain one `{code}` placeholder, rendered as the step's inline code. */
  body: string;
}

type Six<T> = [T, T, T, T, T, T];
type Four<T> = [T, T, T, T];
type Three<T> = [T, T, T];

export interface Dict {
  meta: {
    /** <title> */
    title: string;
    description: string;
    /** Alt text of the social preview image. */
    ogAlt: string;
  };
  /** The slogan's second line. */
  tagline: string;
  a11y: {
    skip: string;
    home: string;
    mainNav: string;
    menu: string;
    language: string;
    copy: string;
    copied: string;
    external: string;
  };
  nav: {
    product: string;
    how: string;
    security: string;
    docs: string;
    demo: string;
    tryDemo: string;
  };
  langHint: {
    /** Shown in the page's *target* language: "This page is available in 中文." style. */
    text: string;
    switch: string;
    dismiss: string;
  };
  hero: {
    eyebrow: string;
    /** The h1. The part between `*asterisks*` is emphasised (accent colour). */
    title: string;
    lede: string;
    primary: string;
    secondary: string;
    installLabel: string;
  };
  flow: {
    label: string;
    browserTitle: string;
    online: string;
    userMessage: string;
    toolNote: string;
    assistant: string;
    allow: string;
    deny: string;
    wire: string;
    termSkill: string;
    termWrite: string;
    termWaiting: string;
  };
  why: {
    kicker: string;
    title: string;
    titleLine2: string;
    sub: string;
    sandbox: { title: string; points: Four<string> };
    uncage: { title: string; points: Four<string> };
  };
  how: {
    kicker: string;
    title: string;
    sub: string;
    steps: Three<Step>;
  };
  features: {
    kicker: string;
    title: string;
    sub: string;
    availableLabel: string;
    soonLabel: string;
    soonBadge: string;
    available: Six<Feature>;
    soon: Four<Feature>;
  };
  code: {
    kicker: string;
    title: string;
    sub: string;
    moreTitle: string;
    moreBody: string;
    more: string;
  };
  security: {
    kicker: string;
    title: string;
    sub: string;
    points: Four<TrustPoint>;
    more: string;
  };
  final: {
    title: string;
    sub: string;
    primary: string;
    secondary: string;
  };
  footer: {
    product: string;
    developers: string;
    project: string;
    features: string;
    quickstart: string;
    api: string;
    forAgents: string;
    changelog: string;
    license: string;
    rights: string;
  };
  notFound: {
    title: string;
    body: string;
    home: string;
    docs: string;
  };
}
