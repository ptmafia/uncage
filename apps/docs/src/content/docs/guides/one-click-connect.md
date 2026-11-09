---
title: "One agent, every site"
description: "Connect a computer that already runs Uncage to another Uncage site in one click: the uncage:// link handler, uncage connect, the native confirmation with site identity checks (domain, IDN, IP, first time, look-alike), the local dashboard, and the phishing threat model."
---

A user installs the Uncage agent once. Every site that embeds Uncage can then use it, without another terminal: the site shows a link, the user clicks it, confirms on their own computer, and approves on the site as usual.

:::note[Status]
Built and unit-tested on macOS, Linux and Windows. The test that registers the real handler runs on the macOS, Linux and Windows CI runners (throwaway scheme, temporary home). One-click on a user’s own computer, the real dialogs and the dashboard in a real browser: awaiting device confirmation.
:::

## How it works

1. `uncage setup` (or `uncage agent install`) installs the background agent **and** registers a handler for `uncage://` links with the operating system. `uncage agent uninstall` removes it again.
   - **macOS:** a small per-user application, `~/Library/Application Support/Uncage/UncageConnect.app`, registered with LaunchServices. No admin rights.
   - **Linux:** `~/.local/share/applications/uncage-connect.desktop` and `xdg-mime default` for `x-scheme-handler/uncage`. Skipped with a note when `xdg-mime` is missing.
   - **Windows:** `HKCU\Software\Classes\uncage` (the current user only).
2. Your site shows **Already use Uncage on this computer? Connect in one click**: the `<ConnectMachine>` panel links to `uncage://connect?url=<your site>` (the hub’s [`installInfo.connectUrl`](/docs/reference/http-api/); hidden on mobile). The install command stays the primary path, because a page cannot tell whether the handler exists.
3. The OS runs `uncage connect <link>`, which validates the link, shows the **native confirmation** and, only on Connect, starts the normal device flow: the browser opens the site’s `/device` page and the user clicks Approve.
4. The new site is saved in `~/.uncage/agent.yaml` and the background agent restarts.

You can also run it by hand: `uncage connect https://app.example.com`. See the [CLI reference](/docs/reference/cli/#uncage-connect).

One-click needs `@uncage/cli` 0.4 or newer. An existing 0.3 install gets the handler only after `npm i -g @uncage/cli@latest` and running `uncage agent install` (or `uncage setup`) again, because that is the only place it is registered.

## What is accepted

`uncage connect` accepts `uncage://connect?url=<site>` with **exactly one** parameter, or a bare URL. It refuses, before anything else happens, a site URL that:

- is not `https://` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`),
- carries a user name or password, a query or a fragment,
- contains spaces or control characters, or is longer than 2048 characters,
- has any other scheme (`javascript:`, `data:`, `file:`) or any other `uncage://` action or parameter.

## The confirmation and site identity checks

Before any pairing, a dialog on this computer asks: **Connect this computer to `example.com`?** It shows the site’s **registrable domain** first (from the Public Suffix List, including private suffixes such as `vercel.app`, so each project there is its own owner), then the full hub URL, and what connecting allows: whoever runs the site can start coding-agent sessions on this computer at any time and answer their approval prompts within your local policy, so only connect sites you trust. **Cancel is the default.** The dialog is in the system language (English, Chinese or Japanese).

It adds a line for each of these:

| Warning | When |
| --- | --- |
| International characters | The host is an IDN; its punycode form is shown. |
| Bare IP address | The site is an IP, not a domain. |
| A specific page | The path is neither the root nor the default `/api/uncage`: on a shared origin a path can belong to someone other than the domain’s owner. |
| First time | This computer never connected to that registrable domain before. |
| Looks like another site | The label has the same look-alike skeleton as a connected domain (digits and Cyrillic or Greek letters mapped to Latin, `rn` ≈ `m`, …), or is within edit distance 2 of it. |

How the question is asked, per operating system:

| OS | Dialog |
| --- | --- |
| macOS | `/usr/bin/osascript` (an alert that gives up, as a No, after 10 minutes) |
| Windows | A message box (`WScript.Shell` Popup) with OK and Cancel (default Cancel), shown through the system’s own Windows PowerShell |
| Linux | `zenity` (preferred), else `kdialog`, when a display is available (`DISPLAY` or `WAYLAND_DISPLAY`) |

If there is no dialog tool, or it could not be shown (no graphical session), and the command runs in a terminal, it asks `Connect? [y/N]` there. Without a dialog and without a terminal it refuses and prints how to run it by hand. **No dialog, no connection.** Also:

- Only one question at a time: a page that fires links repeatedly cannot stack dialogs.
- Every prompt, including the terminal one, counts as a No after 10 minutes.
- After the user cancels, the same site is not asked again for 30 seconds.
- Started from a link (`uncage connect --from-link`, which the registered handler uses), the outcome, connected or not and why, is shown as a native notice. On Windows that run is hidden, so no console window appears.
- After the user confirms, the approval page the hub announces must be on the confirmed origin, and the site that answers must be the confirmed URL; otherwise nothing is saved.
- A site’s self-declared name is never shown without its domain.
- Exit codes: `0` connected, `1` cancelled or refused, `2` bad link.

## The local dashboard

`uncage dashboard` opens a page for this computer’s connected sites:

- each site with its name and domain, machine id, connected since, status (online, offline, revoked) and transport, the runtimes it is offered, and its recent redacted activity;
- **Disconnect**: revokes the machine token on the site (like `uncage sites remove`) and restarts the agent;
- turn ACP agents on or off (the same consent as `uncage runtimes enable|disable`), and a read-only view of the local policy.

It is a page on `127.0.0.1` at a random port. The link carries a one-time token in its fragment (`#…`, which browsers never send to a server). The page trades it once for an API token that it keeps in `sessionStorage`, and removes the fragment from the address bar; there is no cookie. Every request must have the right `Host` (`127.0.0.1:<port>`, which defeats DNS rebinding), no foreign `Origin` and the API token in a header, otherwise it gets `403`. There are no CORS headers. It exits when the page is closed or after 30 minutes without a request (`--no-browser` prints the link instead of opening it). The page follows the system language.

## Threat model

One-click makes a phishing attempt cheaper: any web page can fire `uncage://connect?url=https://evil.example`. If it worked silently, the attacker, who is signed in on their own site, would approve the victim’s computer into **their** account and could then drive the user’s coding agent there. What stops that:

- **The native confirmation** shows who is asking, outside the web page, and defaults to No. A page cannot click it.
- **Identity warnings** make look-alikes, IDNs, IP hosts and first-time sites stand out.
- **Against a hostile site the device flow adds nothing:** the site controls its own `/device` page and can approve on its side. **The native confirmation is the only gate**, so confirm only sites you trust. (For an honest site the device flow still compares the code and shows the computer.)
- **No central registry:** Uncage does not vouch for sites. The dialog shows what the link says, not a verdict; users should only confirm a connection they just started.
- What a connected site can do on the computer is unchanged: the [trust model](/docs/concepts/trust-model/), the [local policy](/docs/guides/local-policy/) and per-tool approvals. The dashboard shows and revokes every connection.

See the [security page](/docs/reference/security/#one-click-connect).
