import { readFileSync, writeFileSync } from 'node:fs'

const keep = `  /**
   * Whether the system prompt rides the first user turn instead of the
   * dedicated \`systemInstruction\` slot.
   *
   * DEFAULT ON. Upstream risk control rejects the client-identity phrasing the
   * host prompt carries when it arrives in that slot: a plain 400, whose body is
   * then closed mid-flight, and undici's HTTP/1 parser asserts on a paused
   * parser when the socket ends under it (upstream #5360), which crashes the
   * whole host rather than failing the turn. Moving the same text into the first
   * user turn keeps the instruction and never opens that path.
   *
   * \`DSH_AGY_KEEP_SYSTEM_INSTRUCTION=1\` restores the documented shape for a
   * caller that prefers it (and accepts the 400-and-crash risk).
   */
  private mergeSystemIntoUser(): boolean {
    const raw = (process.env.DSH_AGY_KEEP_SYSTEM_INSTRUCTION ?? '').toLowerCase()
    return raw !== '1' && raw !== 'true'
  }
`

const blockPattern = /<<<<<<< HEAD\r?\n[\s\S]*?>>>>>>> [^\r\n]*\r?\n/

const adapterPath = 'src/adapter/adapter.ts'
let adapter = readFileSync(adapterPath, 'utf8')
const before = adapter
adapter = adapter.replace(blockPattern, keep.replace(/\n/g, '\r\n'))
if (adapter === before) throw new Error('adapter conflict block not matched')
writeFileSync(adapterPath, adapter)

const testPath = 'tests/adapter.test.ts'
const testsSource = readFileSync(testPath, 'utf8')
const match = blockPattern.exec(testsSource)
if (match === null) throw new Error('test conflict block not matched')
const body = match[0]
const marker = "  it('sends the system prompt inside the first user turn by default'"
const index = body.indexOf(marker)
if (index < 0) throw new Error('risk-control tests not found inside the conflict block')
let tests = testsSource.replace(blockPattern, body.slice(index))
writeFileSync(testPath, tests)
console.log('done; markers left:', (tests.match(/<<<<<<<|>>>>>>>/g) ?? []).length)
