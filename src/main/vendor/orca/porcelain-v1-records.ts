// Source: stablyai/orca, commit 6fcc183ab951fb751cf02ccb9e2af3cf129a4316,
// src/main/git/porcelain-v1-records.ts. MIT, Copyright (c) 2026 Lovecast Inc.
// Modified: retain rename/copy origins for path-scoped diff requests.
/** One `git status --porcelain -z` record and its optional rename/copy origin. */
export type PorcelainV1Record = {
  xy: string
  path: string
  originalPath?: string
}

/** Parse `git status --porcelain -z` (v1) into records.
 *
 *  Why `-z` and a real parser rather than splitting lines: without `-z` Git
 *  quotes and escapes paths containing spaces, quotes, or non-ASCII bytes, so a
 *  path comparison against a configured entry would silently miss. With `-z`
 *  paths are raw, but a rename or copy emits its origin as a *second*
 *  NUL-separated field — treating that origin as its own record would invent a
 *  status code out of the leading bytes of a path. */
export function parsePorcelainV1Records(stdout: string): PorcelainV1Record[] {
  const fields = stdout.split('\0')
  const records: PorcelainV1Record[] = []

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    // Why: the trailing NUL yields a final empty field; a record is always
    // `XY<space><path>`, so anything shorter cannot be one.
    if (field.length < 4) {
      continue
    }
    const xy = field.slice(0, 2)
    const record: PorcelainV1Record = { xy, path: field.slice(3) }
    if (xy.includes('R') || xy.includes('C')) {
      record.originalPath = fields[index + 1]
      index++
    }
    records.push(record)
  }

  return records
}
