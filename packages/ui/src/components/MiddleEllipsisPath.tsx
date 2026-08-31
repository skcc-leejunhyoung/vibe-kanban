import { cn } from '../lib/cn';

/**
 * Renders a file path that keeps the filename fully visible and truncates the
 * directory portion with a CSS ellipsis. Shared by the chat file-change rows
 * and the Changes panel so both truncate long paths the same way.
 */
export function MiddleEllipsisPath({
  path,
  className = '',
}: {
  path: string;
  className?: string;
}) {
  const parts = path.split('/');
  const fileName = parts.pop() || path;
  const directory = parts.join('/');

  return (
    <span
      className={cn(
        'min-w-0 max-w-full flex items-baseline overflow-hidden',
        className
      )}
      title={path}
    >
      {directory && (
        <>
          <span className="min-w-0 flex-1 truncate text-low">{directory}</span>
          <span className="shrink-0 text-low">/</span>
        </>
      )}
      <span
        className={cn(
          'min-w-0 shrink-0 truncate font-medium',
          directory ? 'max-w-[calc(100%-0.75rem)]' : 'max-w-full'
        )}
      >
        {fileName}
      </span>
    </span>
  );
}
