const states = ['ready', 'preparing', 'downloading', 'warming', 'error', 'unavailable'] as const;

export interface SearchStatus {
  status: (typeof states)[number];
}

/** The public status never contains model names, paths, or internal error details. */
export function parseSearchStatus(value: unknown): SearchStatus {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'status') ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !states.includes(value.status as SearchStatus['status'])
  ) {
    throw new TypeError('Invalid search status.');
  }
  return { status: value.status as SearchStatus['status'] };
}
