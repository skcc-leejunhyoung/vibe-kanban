import { forwardRef } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { hexToHslString, hslStringToHex } from '../lib/colors';

export const PRESET_COLORS = [
  '0 84% 60%',
  '24 95% 53%',
  '45 93% 58%',
  '158 64% 52%',
  '200 98% 39%',
  '271 81% 56%',
  '330 81% 60%',
  '183 74% 44%',
  '262 52% 47%',
  '142 71% 45%',
  '17 88% 40%',
  '231 48% 48%',
  '220 9% 46%', // Slate Gray - neutral (backlog)
] as const;

export interface InlineColorPickerProps {
  value: string;
  /** isCustomInput is true when the color streams from the native color input */
  onChange: (color: string, isCustomInput?: boolean) => void;
  colors?: readonly string[];
  onKeyDown?: (e: React.KeyboardEvent) => void;
  disabled?: boolean;
  className?: string;
}

export const InlineColorPicker = forwardRef<
  HTMLDivElement,
  InlineColorPickerProps
>(
  (
    { value, onChange, colors = PRESET_COLORS, onKeyDown, disabled, className },
    ref
  ) => {
    const currentIndex = colors.indexOf(value);
    const isCustom = currentIndex === -1;

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (disabled) return;
      // Keys bubbling from the native color input must not cycle presets —
      // that would silently overwrite an in-progress custom color.
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const newIndex =
          currentIndex <= 0 ? colors.length - 1 : currentIndex - 1;
        onChange(colors[newIndex]);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const newIndex =
          currentIndex >= colors.length - 1 ? 0 : currentIndex + 1;
        onChange(colors[newIndex]);
      }

      onKeyDown?.(e);
    };

    return (
      <div
        ref={ref}
        role="radiogroup"
        aria-label="Select a color"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        className={cn('flex flex-wrap gap-half outline-none', className)}
      >
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={color === value}
            disabled={disabled}
            onClick={() => onChange(color)}
            className={cn(
              'w-6 h-6 rounded-full transition-all',
              color === value
                ? 'ring-2 ring-brand ring-offset-1'
                : !disabled && 'hover:scale-110',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
            style={{ backgroundColor: `hsl(${color})` }}
          />
        ))}
        <label
          title="Custom color"
          className={cn(
            'relative flex h-6 w-6 items-center justify-center rounded-full transition-all',
            isCustom
              ? 'ring-2 ring-brand ring-offset-1'
              : 'border border-dashed border-border text-low',
            !isCustom && !disabled && 'hover:scale-110',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          )}
          style={isCustom ? { backgroundColor: `hsl(${value})` } : undefined}
        >
          {!isCustom && <PlusIcon className="size-icon-xs" weight="bold" />}
          <input
            type="color"
            aria-label="Custom color"
            value={hslStringToHex(value) ?? '#808080'}
            onChange={(e) => onChange(hexToHslString(e.target.value), true)}
            disabled={disabled}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
        </label>
      </div>
    );
  }
);

InlineColorPicker.displayName = 'InlineColorPicker';
