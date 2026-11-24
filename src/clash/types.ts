/**
 * Types for the embedded Clash/Mihomo core that routes ONLY agy traffic.
 *
 * Scope: the core is a private egress for this plugin's own requests, not a
 * system proxy. Nothing here touches the host's global dispatcher, the OS proxy
 * settings, or another application's Clash instance — a user without any Clash
 * installation still gets a working route, which is the "zero ops" promise.
 */

/** Persisted state of the embedded core (`$DSH_HOME/agy/agy-clash.json`). */
export interface ClashState {
  /** Master switch: when false the core is not started and agy keeps its old route. */
  enabled: boolean
  /** Subscription URL. Holds a credential — the file is 0600 and the value is never logged. */
  subscriptionUrl: string
  /** Loopback mixed (HTTP+SOCKS) port the core listens on for agy. */
  mixedPort: number
  /** Loopback REST controller port. */
  controllerPort: number
  /** Bearer secret for the controller. */
  controllerSecret: string
  /** Selector group agy's traffic is pinned to; empty means "first selector found". */
  group: string
  /** Whether a transient failure rotates to the next node before the host retries. */
  autoRotate: boolean
  /** Node currently selected in {@link group}, for display and rotation cursor. */
  node: string
  /** ISO timestamp of the last successful subscription fetch. */
  fetchedAt: string
  /** Cores that failed to start, so a broken download is not retried every turn. */
  lastError: string
}

/** What the settings panel renders. Never includes the subscription URL or the secret. */
/** One measured node, as the auto group reports it. */
export interface ClashProbeNode {
  name: string
  /** Round-trip ms; 0 means the probe failed. */
  ms: number
}

/** Result of one on-demand probe of the synthesized auto group. */
export interface ClashProbe {
  total: number
  available: number
  best: ClashProbeNode | null
  nodes: ClashProbeNode[]
}

export interface ClashStatus {
  enabled: boolean
  running: boolean
  mixedPort: number
  /** Redacted subscription host (no path, no token) for display. */
  subscriptionHost: string
  group: string
  node: string
  autoRotate: boolean
  nodes: string[]
  fetchedAt: string
  lastError: string
}

/** One node as the controller reports it. */
export interface ClashNode {
  name: string
  type: string
  /** Last measured delay in ms, 0 when never measured. */
  delay: number
}

/** Default loopback ports; the manager re-allocates when one is taken. */
export const DEFAULT_MIXED_PORT = 47890
export const DEFAULT_CONTROLLER_PORT = 47891

/**
 * How long a started core gets to answer its controller before we call it dead.
 *
 * Generous on purpose: the FIRST start of a subscription that uses GEOIP rules
 * also downloads country.mmdb, and mihomo does not open its REST API until that
 * finishes. A tight window turned "cold cache" into "broken proxy".
 */
export const CORE_READY_TIMEOUT_MS = 60_000

/** Minimum spacing between automatic rotations, so one flapping turn cannot spin nodes. */
export const ROTATE_MIN_INTERVAL_MS = 5_000

/** Environment override for an already-installed core binary (tests, air-gapped hosts). */
export const CORE_PATH_ENV = 'DSH_AGY_CLASH_CORE'

/** Environment override for the subscription URL (keeps it out of the settings file). */
export const SUBSCRIPTION_ENV = 'DSH_AGY_CLASH_SUBSCRIPTION'

/** Empty-state factory for a fresh install. */
export function emptyClashState(): ClashState {
  return {
    enabled: false,
    subscriptionUrl: '',
    mixedPort: DEFAULT_MIXED_PORT,
    controllerPort: DEFAULT_CONTROLLER_PORT,
    controllerSecret: '',
    group: '',
    autoRotate: true,
    node: '',
    fetchedAt: '',
    lastError: '',
  }
}
