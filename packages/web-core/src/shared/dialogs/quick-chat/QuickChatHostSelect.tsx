import type { QuickChatHostOption } from './hostOptions';

/**
 * The "Run on" picker. Its value is the selected OPTION, which
 * `buildQuickChatHostOptions` guarantees is in the list, so what it shows is
 * always the host that requests go to.
 */
export function QuickChatHostSelect({
  options,
  selected,
  disabled,
  onChange,
}: {
  options: readonly QuickChatHostOption[];
  /** `null`: nothing chosen yet (remote web before a host is known). */
  selected: QuickChatHostOption | null;
  disabled?: boolean;
  onChange: (hostId: string | null) => void;
}) {
  return (
    <select
      value={selected?.id ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      className="min-w-0 flex-1 bg-transparent text-sm text-high outline-none disabled:opacity-50"
      aria-label="Quick chat host"
    >
      {!selected && (
        <option value="" disabled>
          Select a host…
        </option>
      )}
      {options.map((option) => (
        <option
          key={option.id ?? ''}
          value={option.id ?? ''}
          disabled={option.state !== 'online'}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}
