import clsx from 'clsx'

type ClassValue = Parameters<typeof clsx>[0]

export function cx(...inputs: ClassValue[]): string {
  return clsx(...inputs)
}
