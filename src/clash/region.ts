/**
 * Node → region, for keeping an account's egress in ONE country.
 *
 * Google scores an account's location rather than a single request's: current
 * IP, the account's login history and its usual region all feed the same
 * decision. A rotation that hops Hong Kong → Japan → Singapore on consecutive
 * failures therefore looks like travel nobody booked, which is exactly the
 * signal the community reports before a soft block.
 *
 * The region is derived from the node LABEL because that is all a subscription
 * gives us: flag emoji first, then the common Chinese and English names. An
 * unrecognised label returns undefined, and callers then fall back to plain
 * ranking — guessing a region from a random token would be worse than not
 * knowing.
 */

const REGION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/🇭🇰|香港|\bhk\b|hong ?kong/i, 'HK'],
  [/🇯🇵|日本|东京|大阪|\bjp\b|japan|tokyo|osaka/i, 'JP'],
  [/🇸🇬|新加坡|狮城|\bsg\b|singapore/i, 'SG'],
  [/🇺🇸|美国|西美|美西|\bus\b|usa|united states|america|los angeles|seattle/i, 'US'],
  [/🇬🇧|英国|伦敦|\buk\b|united kingdom|london/i, 'GB'],
  [/🇰🇷|韩国|首尔|\bkr\b|korea|seoul/i, 'KR'],
  [/🇲🇾|马来|吉隆坡|\bmy\b|malaysia|kuala/i, 'MY'],
  [/🇹🇼|台湾|台北|\btw\b|taiwan|taipei/i, 'TW'],
  [/🇹🇭|泰国|曼谷|\bth\b|thailand|bangkok/i, 'TH'],
  [/🇩🇪|德国|法兰克福|\bde\b|germany|frankfurt/i, 'DE'],
  [/🇫🇷|法国|巴黎|\bfr\b|france|paris/i, 'FR'],
  [/🇳🇱|荷兰|阿姆斯特丹|\bnl\b|netherlands|amsterdam/i, 'NL'],
  [/🇨🇦|加拿大|\bca\b|canada/i, 'CA'],
  [/🇦🇺|澳大利亚|澳洲|悉尼|\bau\b|australia|sydney/i, 'AU'],
  [/🇮🇳|印度|\bin\b|india/i, 'IN'],
  [/🇷🇺|俄罗斯|莫斯科|\bru\b|russia|moscow/i, 'RU'],
]

/** Region code for a node label, or undefined when the label says nothing. */
export function regionOfNode(name: string): string | undefined {
  for (const [pattern, region] of REGION_PATTERNS) {
    if (pattern.test(name)) return region
  }
  return undefined
}
