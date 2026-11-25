import { splitAddress } from '../../mime'

// Lines of addresses, as the To, Cc and Bcc fields and a message's headers hold them.

/** The entries of a line of addresses: split at commas and semicolons, but not inside quotes. */
export function splitList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    if ((char === ',' || char === ';') && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** An entry's bare address, lowercase, for telling whose it is. */
export const addressOf = (entry: string): string => splitAddress(entry).address.toLowerCase()
