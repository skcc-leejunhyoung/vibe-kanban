import React, { useEffect, useState } from 'react';
import { ThemeMode } from 'shared/types';
import { ThemeProviderContext } from '@/shared/hooks/useTheme';
import { applyPrimaryColor, applyTheme } from '@/shared/lib/themeColors';

type ThemeProviderProps = {
  children: React.ReactNode;
  initialTheme?: ThemeMode;
  initialPrimaryColor?: string;
};

export function ThemeProvider({
  children,
  initialTheme = ThemeMode.SYSTEM,
  initialPrimaryColor,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);

  // Update theme when initialTheme changes
  useEffect(() => {
    setThemeState(initialTheme);
  }, [initialTheme]);

  useEffect(() => {
    applyPrimaryColor(initialPrimaryColor);
  }, [initialPrimaryColor]);

  // Delegate to the shared applyTheme so the resolved light/dark class, the OS
  // live-update listener (SYSTEM mode), and the PWA theme-color meta sync all
  // stay in one place (see themeColors.ts).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme);
  };

  const value = {
    theme,
    setTheme,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
