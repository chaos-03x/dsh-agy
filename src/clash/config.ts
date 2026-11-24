/**
 * Subscription YAML -> a runtime config for the embedded core.
 *
 * The subscription is a Clash profile: `proxies`, `proxy-groups` and `rules` are
 * the parts we keep. Everything else in a provider's profile (providers, sniffer,
 * tproxy, tun, listeners) is either host-specific or needs privileges we must not
 * ask for, so the generated config is a MINIMAL runtime: one loopback mixed port,
 * one loopback controller, no LAN, no TUN, no system proxy.
 */

import { parse, stringify } from 'yaml'

/** A parsed Clash profile, narrowed to the fields this plugin consumes. */
export interface SubscriptionProfile {
  proxies: Array<Record<string, unknown> & { name: string }>
  groups: Array<Record<string, unknown> & { name: string; type: string; proxies?: string[] }>
  rules: string[]
}

export interface RuntimeConfigInput {
  profile: SubscriptionProfile
  mixedPort: number
  controllerPort: number
  controllerSecret: string
}

/** A group the panel can pin agy to: selectors are the only switchable kind. */
export interface SelectableGroup {
  name: string
  nodes: string[]
}

const GROUP_PREFERENCE = /节点选择|proxy|select|选择|manual|🚀/i

/**
 * Parse a Clash subscription body.
 *
 * Providers ship either a full profile or a `proxy-providers` wrapper that only
 * points elsewhere; the latter cannot be run without fetching further, so it is
 * rejected with a message naming the reason instead of producing an empty core.
 */
export function parseSubscription(body: string): SubscriptionProfile {
  let doc: unknown
  try {
    doc = parse(body)
  } catch (error) {
    throw new Error(`subscription is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (doc === null || typeof doc !== 'object') throw new Error('subscription is empty')
  const record = doc as Record<string, unknown>
  if (record['proxy-providers'] !== undefined && record.proxies === undefined) {
    throw new Error('subscription uses proxy-providers only — export a Clash profile with inline proxies instead')
  }
  const proxies = Array.isArray(record.proxies) ? record.proxies : []
  const groups = Array.isArray(record['proxy-groups']) ? record['proxy-groups'] : []
  const rules = Array.isArray(record.rules) ? record.rules.filter((r): r is string => typeof r === 'string') : []
  if (proxies.length === 0) throw new Error('subscription contains no proxies')
  return {
    proxies: proxies.filter((p): p is Record<string, unknown> & { name: string } =>
      p !== null && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string'),
    groups: groups.filter((g): g is Record<string, unknown> & { name: string; type: string } =>
      g !== null && typeof g === 'object'
      && typeof (g as { name?: unknown }).name === 'string'
      && typeof (g as { type?: unknown }).type === 'string'),
    rules,
  }
}

/** Groups whose selection actually changes the egress node. */
export function selectableGroups(profile: SubscriptionProfile): SelectableGroup[] {
  return profile.groups
    .filter((g) => g.type === 'select')
    .map((g) => ({ name: g.name, nodes: Array.isArray(g.proxies) ? g.proxies.filter((n): n is string => typeof n === 'string') : [] }))
    .filter((g) => g.nodes.length > 0)
}

/**
 * Pick the group agy should ride: an explicit choice wins when it still exists,
 * otherwise the conventional "node select" group, otherwise the first selector.
 * A profile with no selector gets `undefined` — the caller then leaves the core
 * on its own default route instead of inventing a group.
 */
export function pickGroup(profile: SubscriptionProfile, preferred: string): SelectableGroup | undefined {
  const groups = selectableGroups(profile)
  if (preferred) {
    const exact = groups.find((g) => g.name === preferred)
    if (exact) return exact
  }
  const scored = groups
    .map((g) => ({ g, score: GROUP_PREFERENCE.test(g.name) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.g
}

/**
 * Build the runtime config document.
 *
 * `rules` keeps the provider's routing (so a subscription's DIRECT rules still
 * bypass the proxy) but always ends with a catch-all to the selected group, and
 * the DNS block is pinned to `redir-host`-free minimal settings: fake-ip would
 * hand agy a 198.18.x address it then tries to dial directly.
 */
export function buildRuntimeConfig(input: RuntimeConfigInput): Record<string, unknown> {
  const { profile, mixedPort, controllerPort, controllerSecret } = input
  const group = pickGroup(profile, '')
  const rules = profile.rules.length > 0
    ? [...profile.rules]
    : ['GEOIP,CN,DIRECT']
  if (!rules.some((r) => r.trim().toUpperCase().startsWith('MATCH,'))) {
    rules.push(`MATCH,${group?.name ?? (profile.proxies[0]?.name ?? 'DIRECT')}`)
  }
  return {
    'mixed-port': mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret: controllerSecret,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'normal',
      'default-nameserver': ['223.5.5.5', '1.1.1.1'],
      nameserver: ['223.5.5.5', '1.1.1.1'],
    },
    proxies: profile.proxies,
    'proxy-groups': profile.groups,
    rules,
  }
}

/** Serialize the runtime config (kept separate so tests can assert on the text). */
export function serializeRuntimeConfig(config: Record<string, unknown>): string {
  return stringify(config, { lineWidth: 0 })
}
