import { useId } from "react";
import type { PaginationSlice } from "../lib/pagination";

const DEFAULT_SIZES = [5, 10, 25, 50] as const;

interface PaginationProps<T> {
  /** Accessible label for the `<nav>` landmark, e.g. `"Trading journal pagination"`. */
  label: string;
  /** Noun used in the range summary, e.g. `"entries"`, `"positions"`, `"orders"`. */
  itemLabel?: string;
  slice: PaginationSlice<T>;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}

/**
 * Accessible pagination bar with range readout (`Showing 1–10 of 42 entries`),
 * rows-per-page selector, and keyboard-friendly page buttons.
 */
export function Pagination<T>({
  label,
  itemLabel = "items",
  slice,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_SIZES,
}: PaginationProps<T>) {
  const sizeSelectId = useId();
  const { page, pageSize, totalItems, startIndex, endIndex, hasPrev, hasNext, tokens } = slice;

  if (totalItems === 0) return null;

  return (
    <nav className="pagination" aria-label={label}>
      <div className="pagination-meta num">
        <span>
          Showing <strong>{startIndex + 1}</strong>–<strong>{endIndex}</strong> of <strong>{totalItems}</strong>{" "}
          {itemLabel}
        </span>

        {onPageSizeChange ? (
          <div className="pagination-size">
            <label htmlFor={sizeSelectId} className="muted">
              Show
            </label>
            <select
              id={sizeSelectId}
              className="input input-sm num"
              value={pageSize}
              onChange={(event) => {
                onPageSizeChange(Number(event.target.value));
                onPageChange(1);
              }}
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="pagination-controls">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={!hasPrev}
          aria-label="Previous page"
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </button>

        <ul className="pagination-pages num">
          {tokens.map((token) =>
            typeof token === "number" ? (
              <li key={token}>
                <button
                  type="button"
                  className="pagination-page"
                  aria-current={token === page ? "page" : undefined}
                  aria-label={`Page ${token}`}
                  onClick={() => {
                    if (token !== page) onPageChange(token);
                  }}
                >
                  {token}
                </button>
              </li>
            ) : (
              <li key={token} className="pagination-ellipsis" aria-hidden="true">
                …
              </li>
            ),
          )}
        </ul>

        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={!hasNext}
          aria-label="Next page"
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
