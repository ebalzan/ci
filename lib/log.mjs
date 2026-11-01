// log.mjs — the CLI's terminal output, shared by sync and onboard: colors (off
// when stdout is not a TTY or NO_COLOR is set), the step/ok/warn/fail lines and
// the [y/N] prompt.

import process from 'node:process'
import { createInterface } from 'node:readline/promises'

const color = code => text =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text
export const bold = color(1)
export const dim = color(2)
export const red = color(31)
export const green = color(32)
export const yellow = color(33)
export const cyan = color(36)

export const info = (text = '') => console.log(text)
export const step = text => console.log(`${cyan(bold('==>'))} ${text}`)
export const ok = text => console.log(`${green(' ✓')} ${text}`)
export const warn = text => console.log(yellow(` ! ${text}`))
export const fail = text => console.error(red(` ✗ ${text}`))

// confirm QUESTION — true only for an explicit y/Y; a closed stdin is a no.
export async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const closed = new Promise(done => rl.once('close', () => done('')))
  try {
    return /^y$/i.test(
      (await Promise.race([rl.question(yellow(`${question} [y/N] `)), closed])).trim(),
    )
  } finally {
    rl.close()
  }
}
