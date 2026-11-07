import type { SkillSpec } from '@uncage/protocol';

/** How to build a landing page this website can publish. Sent to the machine as plain text. */
export const landingPageSkill: SkillSpec = {
  name: 'landing-page',
  description:
    'Build a single-folder static landing page and publish it to the website with the create_asset and publish_asset tools.',
  markdown: `# Landing page for this website

Use this when the user asks for a landing page (落地页), product page or marketing page.

## Output format
- One folder in the workspace, e.g. \`landing/\`. Its entry point is \`landing/index.html\`.
- Plain HTML with **inline** \`<style>\` and \`<script>\`. No build step, no frameworks.
- **No external resources**: no CDNs, web fonts, remote images or analytics. The website shows the
  page in a sandbox that blocks network access, so anything remote will not load. Use system fonts,
  CSS gradients, inline SVG or emoji for visuals.
- One clear \`<h1>\` headline, a short value proposition, 3–4 feature sections and a call to action.
- Responsive (works at 375 px and 1440 px wide). Write the copy in the user's language.

## Steps
1. Call \`create_asset\` with \`{ "title": "<page title>", "kind": "landing-page" }\` and keep the
   returned \`assetId\`.
2. Write \`landing/index.html\` (and only small extra files if really needed).
3. Call \`publish_asset\` with \`{ "assetId": "<assetId>", "dir": "landing" }\`. The user confirms
   it in the website; if they decline, stop and ask what to change.
4. Tell the user the page is published and can be seen on the website's Assets page.
`,
};

export const demoSkills: SkillSpec[] = [landingPageSkill];
