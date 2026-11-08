---
title: 编写技能
description: 把你网站的规则、格式和模板以技能（SkillSpec）的形式交给 Claude Code：技能如何到达用户电脑、怎样写出模型真正会遵循的技能，以及相关限制。
---

**技能**告诉 Claude Code 你的网站希望某件事怎么做：落地页的格式、应用清单的结构、发布的步骤。它是纯 Markdown，加上可选的模板文件。和任何 [Claude Code 技能](https://docs.claude.com/en/docs/claude-code/skills)一样，Claude Code 在任务符合描述时加载它。

工具决定 Claude Code 能在你的网站上做**什么**；技能决定你希望它**怎么**做。

## 声明技能

```ts title="skills.ts"
import type { SkillSpec } from '@uncage/protocol';

export const landingPage: SkillSpec = {
  name: 'landing-page',
  description:
    'Build a single-folder static landing page and publish it to the website with the create_asset and publish_asset tools.',
  markdown: `# Landing page for this website

Use this when the user asks for a landing page, product page or marketing page.

## Output format
- One folder in the workspace, e.g. \`landing/\`. Its entry point is \`landing/index.html\`.
- Plain HTML with inline \`<style>\` and \`<script>\`. No build step, no frameworks.
- No external resources: no CDNs, web fonts, remote images or analytics. The website shows the page
  in a sandbox that blocks network access.
- Start from \`template.html\` next to this file.

## Steps
1. Call \`create_asset\` with \`{ "title": "<page title>" }\` and keep the returned \`assetId\`.
2. Write \`landing/index.html\`.
3. Call \`publish_asset\` with \`{ "assetId": "<assetId>", "dir": "landing" }\`. The user confirms it;
   if they decline, stop and ask what to change.
4. Tell the user the page is published.
`,
  files: [
    {
      path: 'template.html',
      content: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>{{title}}</title></head>\n<body><h1>{{headline}}</h1></body>\n</html>\n',
    },
  ],
};
```

把它注册到 hub（类型来自 `npm i @uncage/protocol`，也可以交给 TypeScript 推断）：

```ts nocheck
const hub = await createHub({ publicUrl, getUser, tools, skills: [landingPage] });
```

## 技能如何到达 Claude Code

1. 运行开始时，hub 把为这次运行挑选的技能（不使用 [`selectManifest`](/docs/zh-cn/guides/select-manifest/) 时就是全部技能）以文本形式放进这次运行的清单。
2. 在 Claude Code 启动之前，守护进程把每个技能写到会话工作区：

   ```text
   ~/Uncage/<site host>/<session id>/.claude/skills/landing-page/
   ├── SKILL.md          ← frontmatter (name, description) + your markdown
   └── template.html     ← each entry of files[]
   ```

   每次运行都会替换这个文件夹，所以你部署的修改从下一次运行开始生效。路径会被检查：不会在 `.claude/skills/<name>/` 以外写入任何东西，也从不跟随符号链接。
3. Claude Code 看到技能的名称和描述，在任务符合时通过它的 `Skill` 工具加载全文。加载技能不需要审批。

技能是数据。hub 从不发送需要电脑执行的代码：模板文件只是模型可以读取和复制的普通文件。

## 写出模型会遵循的技能

- **描述决定何时使用。** 写明它覆盖哪些用户请求（“落地页、产品页、营销页”），以及它会驱动哪些工具。控制在一两句话。
- **先讲输出格式**，再列编号步骤。要具体：文件夹名、文件名、用哪些参数调用哪个工具。
- **给约束写明原因**（“网站在一个禁止网络访问的沙箱里展示页面”），这样模型在你没列出的情况下也能做出正确选择。
- **告诉它用户拒绝确认、或工具失败时该怎么做。**
- **用你的用户所用的语言来写**，或者让模型用用户的语言回复。
- **按名称指向模板文件**（“从本文件旁边的 `template.html` 开始”）。
- 在真实的 Claude Code 上用真实的提示词测试：把 [connected demo](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo) 或你的网站连到你自己的电脑上运行，然后阅读工具步骤。

## 限制

| | 限制 |
| --- | --- |
| `name` | `^[a-z][a-z0-9-]{0,47}$`（小写字母、数字、短横线），唯一 |
| `description` | 1000 个字符 |
| `markdown` | 256 KiB |
| `files` | 每个技能 200 个，每个 256 KiB；使用正斜杠的相对路径，唯一（不区分大小写），不能是 `SKILL.md` |
| 每次运行的技能数 | 64 |

技能无效或重复时，`createHub` 会在启动时抛错。

技能适用于 Claude Code。Codex 会话目前会忽略它们。
