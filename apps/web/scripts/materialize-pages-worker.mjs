import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PLACEHOLDER = 'https://__LH_WORKER_URL__'

function readDotEnvValue(name) {
  for (const file of ['.env.production.local', '.env.local', '.env.production', '.env']) {
    try {
      const text = readFileSync(resolve(file), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([^#=]+)=(.*)$/)
        if (match?.[1].trim() !== name) continue
        const value = match[2].trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          return value.slice(1, -1)
        }
        return value
      }
    } catch {
      // Try the next dotenv file. CI usually supplies process.env directly.
    }
  }
  return undefined
}

const configuredUrl =
  process.env.NEXT_PUBLIC_API_URL || readDotEnvValue('NEXT_PUBLIC_API_URL')

if (!configuredUrl) {
  throw new Error('NEXT_PUBLIC_API_URL is required to materialize the Pages API proxy')
}

const workerOrigin = configuredUrl.replace(/\/+$/, '')
const workerPath = resolve('out/_worker.js')
const source = readFileSync(workerPath, 'utf8')

if (!source.includes(PLACEHOLDER)) {
  throw new Error(`${workerPath} does not contain the expected Worker URL placeholder`)
}

writeFileSync(workerPath, source.split(PLACEHOLDER).join(workerOrigin))
