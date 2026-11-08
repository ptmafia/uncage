import type { SkillSpec } from '@uncage/protocol';
import { docsUrl } from './config.ts';

/** The help site linked from the skill when `DOCS_URL` is not set. */
export const DEFAULT_DOCS_URL = 'https://uncage.vercel.app/docs/';

/** Facts about Uncage, so a page "about Uncage" describes the real product instead of guessing. */
function aboutUncage(docs: string): string {
  return `## About Uncage (use these facts when the page is about Uncage)
Uncage is an open-source (MIT) set of npm packages that lets a website drive each user's own
Claude Code on the user's own computer. This website is built with it.
- The website gives the instructions; the user's own Claude Code does the work on their machine,
  under their own login. The user connects a computer (macOS, Windows or Linux) once with one command
  (\`curl -fsSL <site>/api/uncage/install.sh | bash\`, or \`irm <site>/api/uncage/install.ps1 | iex\` on Windows),
  which installs what is missing, then approves the computer in the browser.
- The website offers **site tools** (like \`create_asset\` and \`publish_asset\` here), which run on the
  website's server as the signed-in user, and **skills** (like this one) that describe its formats.
- **Approvals**: Claude Code's permission prompts and the site tools that need confirmation show an
  approval card in the website's chat, and that step waits until the user answers. The website never sends code or shell commands to the user's computer.
- The process and the results stay on the website: the conversation stays readable after the
  computer goes offline, and published pages are stored and served by the website.
- Documentation: ${docs}
Do not invent other features, pricing, customers or statistics.
`;
}

/** How to build a landing page this website can publish. Sent to the machine as plain text. */
export function makeLandingPageSkill(env: Record<string, string | undefined> = process.env): SkillSpec {
  return {
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

${aboutUncage(docsUrl(env) ?? DEFAULT_DOCS_URL)}`,
  };
}

export const landingPageSkill: SkillSpec = makeLandingPageSkill();

export const demoSkills: SkillSpec[] = [landingPageSkill];
