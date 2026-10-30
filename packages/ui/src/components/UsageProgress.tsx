import type { ReactNode } from 'react';

export function UsageProgress({
  label,
  usedPercent,
  detail,
}: {
  label: string;
  usedPercent: number;
  detail?: ReactNode;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex justify-between gap-base">
        <span>{label}</span>
        <span>
          {usedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%
        </span>
      </span>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent}
        className="h-1 overflow-hidden rounded-sm bg-secondary"
      >
        <span
          className="block h-full bg-brand"
          style={{ width: `${usedPercent}%` }}
        />
      </span>
      {detail && <span className="text-sm text-low">{detail}</span>}
    </span>
  );
}
