// Support file for type-checking the homepage samples (not shown on the site).
export const db = {
  pages: {
    async create(p: { owner: string; title: string; html: string }): Promise<{ url: string }> {
      return { url: `https://your.site/p/${encodeURIComponent(p.title)}?by=${p.owner}&n=${p.html.length}` };
    },
  },
};
