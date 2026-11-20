/**
 * Pure pagination helpers: page clamping, slice bounds, and compact page-button
 * window generation with ellipsis markers.
 */

export type PageToken = number | "ellipsis-start" | "ellipsis-end";

export interface PaginationSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  tokens: PageToken[];
}

/**
 * Computes compact 1-based page number tokens with ellipses so the pagination
 * bar never overflows even across hundreds of pages.
 */
export function buildPageTokens(currentPage: number, totalPages: number): PageToken[] {
  if (totalPages <= 1) return [1];
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }

  const tokens: PageToken[] = [1];
  const windowStart = Math.max(2, Math.min(currentPage - 1, totalPages - 4));
  const windowEnd = Math.min(totalPages - 1, Math.max(currentPage + 1, 5));

  if (windowStart > 2) {
    tokens.push("ellipsis-start");
  }
  for (let p = windowStart; p <= windowEnd; p += 1) {
    tokens.push(p);
  }
  if (windowEnd < totalPages - 1) {
    tokens.push("ellipsis-end");
  }
  tokens.push(totalPages);
  return tokens;
}

/**
 * Slices a list for the requested 1-based `page` and `pageSize`, automatically
 * clamping `page` into `[1, totalPages]` when filters shrink the list.
 */
export function paginateList<T>(list: readonly T[], page: number, pageSize: number): PaginationSlice<T> {
  const safeSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 10;
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const clampedPage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), totalPages) : 1;

  const startIndex = totalItems === 0 ? 0 : (clampedPage - 1) * safeSize;
  const endIndex = totalItems === 0 ? 0 : Math.min(totalItems, startIndex + safeSize);
  const items = list.slice(startIndex, endIndex);

  return {
    items,
    page: clampedPage,
    pageSize: safeSize,
    totalItems,
    totalPages,
    startIndex,
    endIndex,
    hasPrev: clampedPage > 1,
    hasNext: clampedPage < totalPages,
    tokens: buildPageTokens(clampedPage, totalPages),
  };
}
