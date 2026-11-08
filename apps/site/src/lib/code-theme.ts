/** Shiki theme for the homepage code panels: warm dark, brand orange keywords (matches the terminal art). */
export const codeTheme = {
  name: 'uncage-warm',
  type: 'dark' as const,
  colors: { 'editor.background': '#1d1b18', 'editor.foreground': '#e9e2d6' },
  settings: [
    { settings: { foreground: '#e9e2d6', background: '#1d1b18' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#a59c8c', fontStyle: 'italic' } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'variable.language'],
      settings: { foreground: '#f0a35e' },
    },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], settings: { foreground: '#9fd39b' } },
    { scope: ['constant.numeric', 'constant.language', 'support.constant'], settings: { foreground: '#e7b98a' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: '#f3d9a4' } },
    { scope: ['entity.name.tag', 'support.class.component', 'entity.name.type', 'support.type'], settings: { foreground: '#8fc4d9' } },
    { scope: ['entity.other.attribute-name', 'meta.object-literal.key', 'variable.other.property'], settings: { foreground: '#e2cfb6' } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: '#bdb3a3' } },
  ],
};
