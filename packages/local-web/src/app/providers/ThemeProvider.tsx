import React, { useEffect, useState } from 'react';
import { ThemeMode } from 'shared/types';
import { ThemeProviderContext } from '@/shared/hooks/useTheme';
import { applyPrimaryColor } from '@/shared/lib/themeColors';

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

  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === ThemeMode.SYSTEM) {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';

      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme.toLowerCase());
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
