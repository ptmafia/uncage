---
title: スキルを書く
description: ウェブサイトのルール・フォーマット・テンプレートをスキル（SkillSpec）としてClaude Codeに渡す方法、スキルがユーザーのコンピュータに届く仕組み、モデルが実際に従うスキルの書き方、そして上限について説明します。
---

**スキル**は、ウェブサイトが物事をどう進めてほしいかをClaude Codeに伝えるものです。ランディングページのフォーマット、アプリのマニフェストの構造、公開の手順などがこれにあたります。中身はプレーンなMarkdownと、任意のテンプレートファイルです。他の[Claude Codeのスキル](https://docs.claude.com/en/docs/claude-code/skills)と同じく、タスクがスキルの説明に合致するとClaude Codeが読み込みます。

ツールはClaude Codeがサイト上で**何を**できるかを、スキルはそれを**どう**やってほしいかを表します。

## スキルを宣言する

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

ハブに登録します（型が必要なら`npm i @uncage/protocol`を実行するか、TypeScriptに推論させてください）。

```ts nocheck
const hub = await createHub({ publicUrl, getUser, store, tools, skills: [landingPage] });
```

## スキルがClaude Codeに届くまで

1. 実行が始まると、ハブはその実行用に選ばれたスキル（[`selectManifest`](/docs/ja/guides/select-manifest/)を使わない限りすべて）をテキストとして実行のマニフェストに入れます。
2. エージェントはClaude Codeの起動前に、各スキルをセッションのワークスペースに書き出します。

   ```text
   ~/Uncage/<site host>/<session id>/.claude/skills/landing-page/
   ├── SKILL.md          ← frontmatter (name, description) + your markdown
   └── template.html     ← each entry of files[]
   ```

   このフォルダは実行のたびに置き換えられるため、デプロイした変更は次の実行から反映されます。パスは検証されます。`.claude/skills/<name>/`の外には何も書き込まれず、シンボリックリンクがたどられることもありません。
3. Claude Codeはスキルの名前と説明を参照し、タスクが合致すると`Skill`ツールで全文を読み込みます。スキルの読み込みに承認は不要です。

スキルはデータです。ハブがコンピュータで実行させるコードを送ることはありません。テンプレートファイルは、モデルが読んだりコピーしたりできる単なるファイルです。

## モデルが従うスキルの書き方

- **いつ使われるかは説明（description）で決まります**。対象となるユーザーの依頼（「ランディングページ、製品ページ、マーケティングページ」）と、そのスキルが使うツールを明記してください。長さは1〜2文に収めます。
- **まず出力フォーマットを示し**、次に番号付きの手順を書きます。フォルダ名、ファイル名、どのツールをどの引数で呼ぶかなど、具体的に書いてください。
- **制約には理由を添えます**（「ウェブサイトはネットワークアクセスを遮断するサンドボックスでページを表示します」）。そうすれば、列挙していないケースでもモデルが適切に判断できます。
- **ユーザーが確認を拒否したとき**や、ツールが失敗したときにどうするかを伝えます。
- **ユーザーが使う言語で書きます**。または、ユーザーの言語で返答するようモデルに指示します。
- **テンプレートファイルは名前で示します**（「このファイルの隣にある`template.html`から始めてください」）。
- 実際のClaude Codeで、実際のプロンプトを使ってテストしてください。[connected demo](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo)または自分のサイトを自分のコンピュータに接続して動かし、ツールのステップを確認します。

## 上限

| | 上限 |
| --- | --- |
| `name` | `^[a-z][a-z0-9-]{0,47}$`（小文字・数字・ハイフン）、一意 |
| `description` | 1000文字 |
| `markdown` | 256 KiB |
| `files` | スキルあたり200個、各256 KiB。スラッシュ区切りの相対パス。大文字・小文字を区別せずに一意であること、`SKILL.md`は不可 |
| 実行あたりのスキル数 | 64 |

スキルが無効または重複している場合、`createHub`は起動時に例外を投げます。

スキルは、Codexの実行も含めて、すべての実行に渡されます。Claude Codeのランタイムは、スキルをセッションフォルダ（`.claude/skills/`）に配置します。Codexのランタイムはスキルを受け取りますが、まだ使いません。スキル対応を`unknown`と報告しているため、Codexでのスキルは検証されていません。
