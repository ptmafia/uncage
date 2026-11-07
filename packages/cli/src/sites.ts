import { loadAgentConfig, updateAgentSites, type AgentSite } from '@uncage/agent';

export const SITES_HELP = `uncage sites - websites this computer is connected to

Usage:
  uncage sites                 List connected websites.
  uncage sites remove <id>     Disconnect a website: revokes this machine on the website and
                               removes its token from ~/.uncage/agent.yaml. Local session data
                               (~/.uncage/sites/<id>) and workspaces (~/Uncage/...) are kept.`;

export function formatSites(sites: AgentSite[]): string {
  if (sites.length === 0) return 'No connected websites. Connect one with: uncage setup <url>';
  const rows = sites.map((s) => [s.id, s.name, new URL(s.url).host, s.machineId, s.revokedAt ? `revoked ${s.revokedAt}` : 'active']);
  const head = ['ID', 'NAME', 'HOST', 'MACHINE', 'STATUS'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export async function listSites(home: string): Promise<string> {
  return formatSites((await loadAgentConfig(home)).sites);
}

/**
 * Revokes the machine on the website (`POST <site>/machine/revoke` with its own token), then
 * removes the site locally. An unreachable website is reported but the local token is removed
 * anyway (it can still be revoked from the website's machine list).
 */
export async function removeSite(o: { home: string; id: string; fetch: typeof fetch; out: (l: string) => void }): Promise<void> {
  const site = (await loadAgentConfig(o.home)).sites.find((s) => s.id === o.id);
  if (!site) throw new Error(`No connected website "${o.id}". See: uncage sites`);
  if (!site.revokedAt) {
    try {
      const res = await o.fetch(`${site.url}/machine/revoke`, { method: 'POST', headers: { authorization: `Bearer ${site.token}` } });
      if (res.ok) o.out(`✓ Revoked this machine on ${new URL(site.url).host}.`);
      else if (res.status === 401) o.out(`The website no longer knew this machine (already revoked).`);
      else o.out(`! The website answered HTTP ${res.status}; remove the machine from the website's machine list too.`);
    } catch {
      o.out(`! Could not reach ${new URL(site.url).host}; remove the machine from the website's machine list too.`);
    }
  }
  await updateAgentSites(o.home, (sites) => sites.filter((s) => s.id !== o.id));
  o.out(`✓ Removed ${o.id} from ~/.uncage/agent.yaml.`);
}
