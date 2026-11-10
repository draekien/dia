/**
 * The upper-case first letters of the first two words of `name`, such as "AL" for "Ada
 * Lovelace", for an `AvatarFallback`. Returns an empty string for a blank name.
 */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
