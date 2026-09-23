/** Small, non-blocking spinner for inline loading states. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size }}
      className="inline-block rounded-full border-2 border-border border-t-accent animate-spin"
    />
  );
}
