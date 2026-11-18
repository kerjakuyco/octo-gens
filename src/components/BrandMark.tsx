/** The ring mark: one spot of the blue-ringed octopus. Also the assistant's signature. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="var(--ochre)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--ring)" strokeWidth="4" />
      <circle cx="16" cy="16" r="3" fill="var(--bg)" />
    </svg>
  );
}
